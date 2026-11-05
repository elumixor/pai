import { rmSync } from "node:fs";
import { ensureTranscriptAt, forkTranscript, type ForgetTarget, pruneTranscript, transcriptPath } from "./transcript.ts";
import { Session, UNTITLED, asKind, closeWarm, prewarm, rewarm, type AgentSetup, type Effort, type SessionKind, type ThreadOrigin } from "./session.ts";
import { db, kv, now } from "../core/db.ts";
import { existsSync, watch } from "node:fs";
import { join } from "node:path";
import { config } from "../core/config.ts";
import { bus, type PaiEvent } from "../core/bus.ts";
import { containing, get as getProject } from "./projects.ts";
import { logger } from "../core/log.ts";
import * as messages from "./messages.ts";

const log = logger("sessions");

const live = new Map<string, Session>();

/** Conversations a terminal holds (the mirror): busy or idle by their transcripts, though no process of ours runs them. */
export const terminalStates = new Map<string, "busy" | "idle">();

export interface SpawnTask {
  title: string;
  project?: string;
  private?: boolean;
  threadId?: number | null;
  /** The session that asked for it; the task's reports go there as well as to the main conversation. */
  parent?: string | null;
  model?: string | null;
  effort?: Effort | null;
  /** The agent the session works for; its role and tools come with it. */
  agent?: AgentSetup;
  /** A working directory other than the project's or the workspace (an agent's folder). */
  cwd?: string;
  origin?: ThreadOrigin;
}

/** How a revived session finds its agent's setup again; agents.ts registers it, so this file does not import that one. */
let agentSetup: (slug: string) => AgentSetup | undefined = () => undefined;
export function resolveAgentsWith(fn: (slug: string) => AgentSetup | undefined) {
  agentSetup = fn;
}

/** A task session: its own topic, its own context. With a project it runs in that repo. */
export function spawnTask(opts: SpawnTask): Session {
  let kind: SessionKind = "chat";
  let cwd = config.workspace;
  let project: string | undefined;
  if (opts.project) {
    const proj = getProject(opts.project);
    if (!proj) throw new Error(`unknown project: ${opts.project}`);
    kind = proj.kind === "repo" ? "code" : "chat";
    cwd = proj.path;
    project = proj.slug;
  }
  if (opts.cwd) cwd = opts.cwd;
  const session = new Session({ kind, title: opts.title.trim() || UNTITLED, cwd, project, threadId: opts.threadId, parent: opts.parent, model: opts.model, effort: opts.effort, agent: opts.agent, origin: opts.origin ?? (opts.threadId != null ? "phone" : undefined), private: opts.private });
  live.set(session.id, session);
  log.info(`spawned ${kind} ${session.shortId} "${opts.title}"`);
  prewarm("chat");
  bus.emitEvent("task.created", session.summary(), session.id);
  return session;
}

export function find(idOrShort: string): Session | undefined {
  const exact = live.get(idOrShort);
  if (exact) return exact;
  return [...live.values()].find((s) => s.shortId === idOrShort || s.id.startsWith(idOrShort));
}

export function byThread(threadId: number): Session | undefined {
  const l = [...live.values()].find((s) => s.threadId === threadId && s.state !== "dead");
  if (l) return l;
  const row = db
    .query("SELECT session_id FROM sessions WHERE thread_id = ? ORDER BY last_activity DESC LIMIT 1")
    .get(threadId) as { session_id: string } | undefined;
  return row ? ensureLive(row.session_id) : undefined;
}

/**
 * A session records the directory it ran in, which does not survive the daemon moving to
 * another machine. Falling back keeps old conversations resumable instead of failing to
 * spawn with ENOENT.
 */
function workingDirectory(recorded: string, project: string | null) {
  if (existsSync(recorded)) return recorded;
  const fallback = (project ? getProject(project)?.path : undefined) ?? config.workspace;
  log.warn(`${recorded} is gone; resuming in ${fallback}`);
  return fallback;
}

/** Resumes a session whose process died but whose transcript is still on disk. */
export function revive(sessionId: string): Session | undefined {
  const row = db.query("SELECT * FROM sessions WHERE session_id = ?").get(sessionId) as
    | { kind: SessionKind; title: string; cwd: string; project: string | null; thread_id: number | null; parent_id: string | null; agent: string | null }
    | undefined;
  if (!row) return undefined;
  const cwd = workingDirectory(row.cwd, row.project);
  // A terminal may have carried the conversation on since, on this machine or another.
  ensureTranscriptAt(sessionId, cwd);
  const session = new Session({
    kind: asKind(row.kind),
    title: row.title,
    cwd,
    project: row.project ?? undefined,
    threadId: row.thread_id,
    parent: row.parent_id,
    resume: sessionId,
    agent: row.agent ? agentSetup(row.agent) : undefined,
  });
  live.set(session.id, session);
  log.info(`revived ${session.shortId} "${row.title}"`);
  return session;
}

/**
 * Takes over a conversation the daemon has never seen — one started with `claude` in a
 * terminal — by resuming its transcript. From here on it is a session like any other.
 */
export function adopt(sessionId: string, cwd: string, title: string): Session {
  const known = ensureLive(sessionId);
  if (known) return known;
  const project = containing(cwd);
  // A transcript written by another machine sits under that machine's path; `claude --resume` looks only under this one.
  ensureTranscriptAt(sessionId, workingDirectory(cwd, project?.slug ?? null));
  const session = new Session({
    kind: project ? "code" : "chat",
    title: title.slice(0, 80) || sessionId.slice(0, 8),
    cwd: workingDirectory(cwd, project?.slug ?? null),
    project: project?.slug,
    resume: sessionId,
    origin: "terminal",
  });
  live.set(session.id, session);
  log.info(`adopted ${session.shortId} "${session.title}" from ${cwd}`);
  bus.emitEvent("task.created", { ...session.summary(), adopted: true }, session.id);
  return session;
}

/**
 * Changes what a session runs with. The process is stopped so the next message starts one
 * with the new options; a turn in flight is cut off, which is why a busy session is refused.
 */
export function reconfigure(id: string, prefs: { model?: string | null; effort?: Effort | null }) {
  const full = resolveId(id);
  if (!full) throw new Error(`no such session: ${id}`);
  const s = find(full);
  if (s && s.state === "busy") throw new Error(`${s.shortId} is mid-turn`);
  const current = db.query("SELECT model_pref, effort FROM sessions WHERE session_id = ?").get(full) as { model_pref: string | null; effort: Effort | null };
  const model = prefs.model === undefined ? current.model_pref : prefs.model;
  const effort = prefs.effort === undefined ? current.effort : prefs.effort;
  db.prepare("UPDATE sessions SET model_pref = ?, effort = ? WHERE session_id = ?").run(model, effort, full);
  if (s && s.state !== "dead") s.kill();
  return { sessionId: full, model, effort };
}

/** Live session for `id`, respawning from disk if its process is gone. */
export function ensureLive(id: string): Session | undefined {
  const session = find(id);
  if (session && session.state !== "dead") return session;
  const full = session?.id ?? resolveId(id);
  if (!full) return undefined;
  live.delete(full);
  return revive(full);
}

export function resolveId(idOrShort: string): string | undefined {
  const row = db
    .query("SELECT session_id FROM sessions WHERE session_id = ? OR short_id = ? ORDER BY last_activity DESC LIMIT 1")
    .get(idOrShort, idOrShort) as { session_id: string } | undefined;
  return row?.session_id;
}

export function list() {
  return [...live.values()].filter((s) => s.state !== "dead" && !trashed(s.id)).map((s) => s.summary());
}

export interface SessionRow {
  sessionId: string;
  shortId: string;
  kind: SessionKind;
  title: string;
  project: string | null;
  cwd: string | null;
  threadId: number | null;
  parent: string | null;
  state: string;
  startedAt: number;
  lastActivity: number;
  lastResult: string;
  costUsd: number;
  turns: number;
  model: string | null;
  modelPref: string | null;
  effort: Effort | null;
  agent: string | null;
  origin: ThreadOrigin | null;
}

// ---- the trash: a thread deleted goes there first, with everything under it; for good after 30 days -------------

export const TRASH_DAYS = 30;
const trashed = (id: string) => Boolean(db.query("SELECT 1 FROM sessions WHERE session_id = ? AND deleted_at IS NOT NULL").get(id));

/** The thread and every thread started under it. */
function withChildren(ids: readonly string[]): string[] {
  const all = new Set<string>();
  const add = (id: string) => {
    if (all.has(id)) return;
    all.add(id);
    for (const r of db.query("SELECT session_id FROM sessions WHERE parent_id = ?").all(id) as { session_id: string }[]) add(r.session_id);
  };
  for (const raw of ids) {
    const id = resolveId(raw);
    if (id) add(id);
  }
  return [...all];
}

/** Moves threads (and what hangs under them) to the trash; a running one is stopped. Agents' sessions are not threads. */
export function trash(ids: readonly string[]): string[] {
  const at = now();
  const moved = withChildren(ids).filter((id) => !(db.query("SELECT 1 FROM sessions WHERE session_id = ? AND (kind = 'main' OR agent IS NOT NULL)").get(id)));
  for (const id of moved) {
    db.prepare("UPDATE sessions SET deleted_at = ? WHERE session_id = ? AND deleted_at IS NULL").run(at, id);
    const s = live.get(id);
    if (s && s.state !== "dead") s.kill();
  }
  if (moved.length) bus.emitEvent("sessions.trashed", { ids: moved });
  return moved;
}

/** Takes threads back out of the trash. */
export function restore(ids: readonly string[]): string[] {
  const back = withChildren(ids).filter((id) => db.prepare("UPDATE sessions SET deleted_at = NULL WHERE session_id = ? AND deleted_at > 0").run(id).changes > 0);
  if (back.length) bus.emitEvent("sessions.restored", { ids: back });
  return back;
}

/**
 * Deletes threads for good: what pai kept about them goes, the row stays as a tombstone (`deleted_at = -1`) so a
 * transcript still on disk is never mirrored back in. The transcript itself is Claude Code's, and stays.
 */
export function purge(ids: readonly string[]): string[] {
  const gone = withChildren(ids).filter((id) => trashed(id));
  for (const id of gone) {
    db.prepare("UPDATE sessions SET deleted_at = -1, title = '', parent_id = NULL WHERE session_id = ?").run(id);
    db.prepare("DELETE FROM keep_threads WHERE session_id = ?").run(id);
    live.delete(id);
  }
  return gone;
}

/** Ends these sessions and leaves only tombstones, whatever state they were in, so the mirror never brings one back. */
export function erase(ids: ReadonlySet<string>) {
  for (const id of ids) {
    live.get(id)?.kill();
    live.delete(id);
    db.prepare("UPDATE sessions SET deleted_at = -1, title = '', parent_id = NULL, thread_id = NULL WHERE session_id = ?").run(id);
    db.prepare("DELETE FROM keep_threads WHERE session_id = ?").run(id);
  }
}

/** A private chat ends: its process, its transcript, every trace in the db; only a nameless tombstone stays. */
export function closePrivate(id: string) {
  if (!bus.hidden.has(id)) return false;
  const path = transcriptPath(id);
  erase(new Set([id]));
  const wipe = () => {
    if (path) rmSync(path, { force: true });
    if (path) rmSync(path.replace(/\.jsonl$/, ""), { recursive: true, force: true });
  };
  wipe();
  // A dying process can still write its last line.
  setTimeout(wipe, 3000);
  db.prepare("DELETE FROM events WHERE session_id = ?").run(id);
  db.prepare("DELETE FROM archive WHERE ref = ?").run(id);
  db.prepare("DELETE FROM private_sessions WHERE session_id = ?").run(id);
  bus.hidden.delete(id);
  return true;
}

const PRIVATE_IDLE_MS = 60 * 60 * 1000;

/** Private chats do not outlive the daemon, and one whose tab was closed goes after an idle hour. */
export function sweepPrivate() {
  for (const { session_id } of db.query("SELECT session_id FROM private_sessions").all() as { session_id: string }[]) bus.hidden.add(session_id), closePrivate(session_id);
  const timer = setInterval(() => {
    for (const id of bus.hidden) {
      const s = live.get(id);
      if (!s || (s.state !== "busy" && Date.now() - s.lastActivity > PRIVATE_IDLE_MS)) closePrivate(id);
    }
  }, 5 * 60 * 1000);
  return () => clearInterval(timer);
}

const forkRow = (id: string) => db.query("SELECT parent_id, turn FROM session_forks WHERE session_id = ?").get(id) as { parent_id: string; turn: number } | undefined;

/**
 * A rewrite: a new conversation with what came before `turn`, so the old one and what followed in it stay whole
 * and can be switched back to. Run here, whoever held the original. Forking at or before where this thread itself
 * branched is a sibling of it, not a child: the words before that point are the same.
 */
export async function forkAt(id: string, turn: number): Promise<Session | undefined> {
  const source = resolveId(id) ?? id;
  const row = db.query("SELECT kind, title, cwd, project, model_pref, effort FROM sessions WHERE session_id = ?").get(source) as { kind: SessionKind; title: string; cwd: string; project: string | null; model_pref: string | null; effort: Effort | null } | undefined;
  if (!row) return undefined;
  const cwd = workingDirectory(row.cwd, row.project);
  const newId = crypto.randomUUID();
  if (!(await forkTranscript(source, turn, newId, cwd))) return undefined;
  let parent = source;
  for (let up = forkRow(parent); up && turn <= up.turn; up = forkRow(parent)) parent = up.parent_id;
  db.prepare("INSERT INTO session_forks (session_id, parent_id, turn, created_at) VALUES (?, ?, ?, ?)").run(newId, parent, turn, Date.now());
  const session = new Session({ kind: asKind(row.kind), title: row.title, cwd, project: row.project ?? undefined, resume: newId, origin: "terminal", model: row.model_pref, effort: row.effort });
  live.set(session.id, session);
  return session;
}

/** The versions of each thing said in this thread, by turn, oldest first: only turns that have more than one. */
export function forksOf(id: string): { turn: number; ids: string[] }[] {
  const full = resolveId(id) ?? id;
  const children = db.query("SELECT session_id, turn FROM session_forks WHERE parent_id = ? ORDER BY created_at").all(full) as { session_id: string; turn: number }[];
  const own = new Map<number, string[]>();
  for (const c of children) own.set(c.turn, [...(own.get(c.turn) ?? [full]), c.session_id]);
  const up = forkRow(full);
  return [...(up ? forksOf(up.parent_id).filter((f) => f.turn <= up.turn) : []), ...[...own].map(([turn, ids]) => ({ turn, ids }))];
}

/** Why these messages cannot be taken out of a conversation now; a terminal mid-turn is writing to the same file. */
export const cannotForget = (id: string) => (terminalStates.get(resolveId(id) ?? id) === "busy" && !find(id) ? "This conversation is mid-turn in a terminal: delete once it is done." : undefined);

/**
 * The model no longer has these messages: the turn is stopped, the process ended so its memory of them goes, they
 * leave the transcript and recall. The next message resumes from what remains.
 */
export async function forget(id: string, targets: readonly ForgetTarget[]) {
  const full = resolveId(id) ?? id;
  const s = find(full);
  if (s?.state === "busy") await s.interrupt().catch(() => false);
  if (s && s.state !== "dead") s.kill();
  await Bun.sleep(s ? 500 : 0);
  const row = db.query("SELECT cwd, project FROM sessions WHERE session_id = ?").get(full) as { cwd: string; project: string | null } | undefined;
  const gone = await pruneTranscript(full, targets, row ? workingDirectory(row.cwd, row.project) : undefined);
  for (const text of gone) db.prepare("DELETE FROM archive WHERE source = 'transcript' AND ref = ? AND body = ?").run(full, text);
}

/** What is in the trash, newest first. */
export function trashList(): { sessionId: string; shortId: string; title: string; kind: SessionKind; project: string | null; deletedAt: number }[] {
  const rows = db.query("SELECT session_id, short_id, title, kind, project, deleted_at FROM sessions WHERE deleted_at > 0 ORDER BY deleted_at DESC").all() as Record<string, any>[];
  return rows.map((r) => ({ sessionId: r.session_id, shortId: r.short_id, title: r.title, kind: asKind(r.kind), project: r.project, deletedAt: r.deleted_at }));
}

/** Empties what has been in the trash longer than `TRASH_DAYS`; daily. */
export function purgeOld() {
  const before = now() - TRASH_DAYS * 86_400_000;
  const old = (db.query("SELECT session_id FROM sessions WHERE deleted_at > 0 AND deleted_at < ?").all(before) as { session_id: string }[]).map((r) => r.session_id);
  if (old.length) log.info(`trash: ${purge(old).length} threads deleted for good after ${TRASH_DAYS} days`);
}

/** The session above one, as the database has it. */
const parentOf = (id: string) => (db.query("SELECT parent_id FROM sessions WHERE session_id = ?").get(id) as { parent_id: string | null } | undefined)?.parent_id ?? null;

/**
 * Puts threads under another session (or at the top, `null`): where the sidebar shows them and where their reports go.
 * A thread is never put under itself or below itself. Answers the ids that moved.
 */
export function move(ids: readonly string[], parent: string | null): string[] {
  const moved: string[] = [];
  for (const raw of ids) {
    const id = resolveId(raw);
    if (!id) continue;
    if (parent) {
      const seen = new Set<string>();
      let up: string | null = parent;
      while (up && up !== id && !seen.has(up)) {
        seen.add(up);
        up = parentOf(up);
      }
      if (up === id) continue;
    }
    db.prepare("UPDATE sessions SET parent_id = ? WHERE session_id = ?").run(parent, id);
    const s = live.get(id);
    if (s) s.parent = parent;
    moved.push(id);
  }
  if (moved.length) bus.emitEvent("sessions.moved", { ids: moved, parent });
  return moved;
}

/** Recent sessions, live or not, newest activity first. */
export function recent(limit = 20, kind?: SessionKind): SessionRow[] {
  const rows = (
    kind
      ? db.query("SELECT * FROM sessions WHERE kind = ? ORDER BY last_activity DESC LIMIT ?").all(kind, limit)
      : db.query("SELECT * FROM sessions WHERE kind != 'main' AND deleted_at IS NULL ORDER BY last_activity DESC LIMIT ?").all(limit)
  ) as Record<string, any>[];
  return rows.map((r) => ({
    sessionId: r.session_id,
    shortId: r.short_id,
    kind: asKind(r.kind),
    title: r.title,
    project: r.project,
    private: bus.hidden.has(r.session_id),
    forkOf: forkRow(r.session_id)?.parent_id,
    cwd: r.cwd,
    threadId: r.thread_id,
    parent: r.parent_id ?? null,
    state: live.get(r.session_id)?.state ?? terminalStates.get(r.session_id) ?? "detached",
    startedAt: r.started_at,
    lastActivity: r.last_activity,
    lastResult: r.last_result ?? "",
    costUsd: r.cost_usd,
    turns: r.turns,
    model: r.model ?? null,
    modelPref: r.model_pref ?? null,
    effort: r.effort ?? null,
    agent: r.agent ?? null,
    origin: r.origin ?? null,
  }));
}

const INTERRUPTED_KEY = "interrupted_sessions";

/**
 * Remembers which sessions were mid-turn, so a restart does not swallow the reply the user
 * is waiting for. Called before the process goes down; `resumeInterrupted` picks it up.
 */
export function noteInterrupted() {
  const ids = [...live.values()].filter((s) => s.awaitingReply || s.pending).map((s) => s.id);
  if (ids.length) kv.set(INTERRUPTED_KEY, ids.join(","));
  else kv.del(INTERRUPTED_KEY);
}

/** Revives the sessions a restart cut off and asks each to finish its turn. */
export function resumeInterrupted() {
  const noted = (kv.get(INTERRUPTED_KEY) ?? "").split(",").filter(Boolean);
  kv.del(INTERRUPTED_KEY);
  for (const id of new Set(noted)) {
    if (find(id)) continue;
    const s = ensureLive(id);
    if (!s) continue;
    log.info(`resuming interrupted ${s.shortId}`);
    s.send(
      "The daemon restarted and cut your last turn off part-way through. Check what already happened, finish what is left, and tell the user where things stand.",
    );
  }
}

export function killAll() {
  closeWarm();
  for (const s of live.values()) s.kill();
  live.clear();
}

/** Readies a process for the next conversation, so first replies are quick. */
export function warmUp() {
  prewarm("chat");
}

/** A new login on the machine: idle processes still hold the old one, so they go and are resumed on their next turn. */
export function recycle() {
  rewarm("chat");
  for (const s of live.values()) {
    if (s.state !== "idle" || s.pending) continue;
    s.kill();
    live.delete(s.id);
  }
}

/** Sessions mid-turn when the tools changed: they go when the turn ends. */
const outdated = new Set<string>();

/** The tools changed: a session's are fixed when its process starts, so idle ones go now and are resumed on their next turn. */
export function applyTools() {
  for (const s of live.values()) if (s.state !== "idle" || s.pending) outdated.add(s.id);
  recycle();
}

/** Frees the subprocess of long-idle task sessions. The session itself stays resumable. */
export function reapIdle() {
  const cutoff = now() - config.idleShutdownMs;
  for (const s of live.values()) {
    if (s.state === "dead") {
      live.delete(s.id);
      continue;
    }
    if (s.state !== "idle" || s.pending) continue;
    const row = db.query("SELECT last_activity FROM sessions WHERE session_id = ?").get(s.id) as
      | { last_activity: number }
      | undefined;
    if (row && row.last_activity < cutoff) {
      log.info(`reaping idle ${s.shortId}`);
      s.kill();
      live.delete(s.id);
    }
  }
}

/** A changed prompt or tool set (memory, a connector's settings): the warm process is rebuilt so the next conversation gets it. */
export const rewarmChat = () => rewarm("chat");

export function watchMemory() {
  const file = join(config.workspace, "MEMORY.md");
  if (!existsSync(file)) return () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watcher = watch(file, () => {
    clearTimeout(timer);
    timer = setTimeout(rewarmChat, 2000);
  });
  return () => watcher.close();
}

/** Who a session is in the message log: its agent, or the thread it is. */
export const party = (s: { agent?: string | null; shortId: string }) => s.agent ?? `thread:${s.shortId}`;

/**
 * What a thread reports goes to the thread that started it, as a note in its context, and into
 * the message log. Agents report through agents.ts instead; this is for threads started with start_thread.
 */
export function relayToParent() {
  bus.on("event", (e: PaiEvent) => {
    if (e.kind !== "session.turn_end" || !e.sessionId || !outdated.delete(e.sessionId)) return;
    const id = e.sessionId;
    // The turn's own state settles just after its event.
    setTimeout(() => {
      const s = live.get(id);
      if (!s) return;
      if (s.state !== "idle" || s.pending) return void outdated.add(id);
      s.kill();
      live.delete(id);
    }, 1000);
  });
  bus.on("event", (e: PaiEvent) => {
    if (!e.sessionId) return;
    const s = find(e.sessionId);
    if (!s?.parent || s.agent) return;
    // General rotates daily: a thread under it reports to its current session.
    const general = db.query("SELECT a.session_id AS id FROM sessions s JOIN agents a ON a.slug = s.agent WHERE s.session_id = ? AND a.slug = 'pai'").get(s.parent) as { id: string | null } | undefined;
    const m = find(general?.id ?? s.parent);
    if (!m || m.state === "dead" || m === s) return;
    const tag = `[thread ${s.shortId} · ${s.title}]`;
    const report = (body: string, kind: "report" | "event" = "report") =>
      messages.log({ from: party(s), to: party(m), kind, body, meta: { session: s.shortId, title: s.title, ...(kind === "event" ? { event: "error" as const } : {}) } });
    if (e.kind === "session.turn_end") {
      const text = String(e.payload.text ?? "").trim();
      if (!text) return;
      m.inject(`${tag} reported:\n${text.slice(0, 1500)}`);
      report(text.slice(0, 1500));
    } else if (e.kind === "session.question") {
      m.inject(`${tag} is waiting for the user to answer a question.`);
    } else if (e.kind === "session.error") {
      m.inject(`${tag} failed: ${e.payload.message}`);
      report(`failed: ${e.payload.message}`, "event");
    }
  });
}
