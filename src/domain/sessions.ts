import { ensureTranscriptAt } from "./transcript.ts";
import { Session, UNTITLED, asKind, closeWarm, prewarm, rewarm, type AgentSetup, type Effort, type SessionKind } from "./session.ts";
import { db, kv, now } from "../core/db.ts";
import { existsSync, watch } from "node:fs";
import { join } from "node:path";
import { config } from "../core/config.ts";
import { bus, type PaiEvent } from "../core/bus.ts";
import { all as allProjects, get as getProject } from "./catalog.ts";
import { logger } from "../core/log.ts";
import * as messages from "./messages.ts";

const log = logger("sessions");

const live = new Map<string, Session>();

/** Conversations a terminal holds (see mirror.ts): busy or idle by their transcripts, though no process of ours runs them. */
export const terminalStates = new Map<string, "busy" | "idle">();

export interface SpawnTask {
  title: string;
  project?: string;
  threadId?: number | null;
  /** The session that asked for it; the task's reports go there as well as to the main conversation. */
  parent?: string | null;
  model?: string | null;
  effort?: Effort | null;
  /** The agent the session works for; its role and tools come with it. */
  agent?: AgentSetup;
  /** A working directory other than the project's or the workspace (an agent's folder). */
  cwd?: string;
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
  const session = new Session({ kind, title: opts.title.trim() || UNTITLED, cwd, project, threadId: opts.threadId, parent: opts.parent, model: opts.model, effort: opts.effort, agent: opts.agent });
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
  const project = getProject(cwd) ?? allProjects().find((p) => cwd === p.path || cwd.startsWith(`${p.path}/`));
  // A transcript written by another machine sits under that machine's path; `claude --resume` looks only under this one.
  ensureTranscriptAt(sessionId, workingDirectory(cwd, project?.slug ?? null));
  const session = new Session({
    kind: project ? "code" : "chat",
    title: title.slice(0, 80) || sessionId.slice(0, 8),
    cwd: workingDirectory(cwd, project?.slug ?? null),
    project: project?.slug,
    resume: sessionId,
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
  return [...live.values()].filter((s) => s.state !== "dead").map((s) => s.summary());
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
}

/** Recent sessions, live or not, newest activity first. */
export function recent(limit = 20, kind?: SessionKind): SessionRow[] {
  const rows = (
    kind
      ? db.query("SELECT * FROM sessions WHERE kind = ? ORDER BY last_activity DESC LIMIT ?").all(kind, limit)
      : db.query("SELECT * FROM sessions WHERE kind != 'main' ORDER BY last_activity DESC LIMIT ?").all(limit)
  ) as Record<string, any>[];
  return rows.map((r) => ({
    sessionId: r.session_id,
    shortId: r.short_id,
    kind: asKind(r.kind),
    title: r.title,
    project: r.project,
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

/** A changed MEMORY.md is a changed prompt: the warm task process is rebuilt so the next task reads it. */
export function watchMemory() {
  const file = join(config.workspace, "MEMORY.md");
  if (!existsSync(file)) return () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watcher = watch(file, () => {
    clearTimeout(timer);
    timer = setTimeout(() => rewarm("chat"), 2000);
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
    if (!e.sessionId) return;
    const s = find(e.sessionId);
    if (!s?.parent || s.agent) return;
    const m = find(s.parent);
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
