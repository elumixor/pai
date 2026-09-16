import { Session, UNTITLED, closeWarm, prewarm, rewarm, type SessionKind } from "./session.ts";
import { db, kv, now } from "../core/db.ts";
import { existsSync } from "node:fs";
import { config } from "../core/config.ts";
import { bus, type PaiEvent } from "../core/bus.ts";
import { all as allProjects, get as getProject } from "./catalog.ts";
import { logger } from "../core/log.ts";

const log = logger("sessions");

const live = new Map<string, Session>();

const MAIN_KEY = "main_session";

/** The one conversation that lives in the root of the chat. Resumed across restarts. */
export function main(): Session {
  const id = kv.get(MAIN_KEY);
  if (id) {
    const existing = ensureLive(id);
    if (existing) return existing;
  }
  const session = new Session({ kind: "main", title: "pai", cwd: config.workspace });
  live.set(session.id, session);
  kv.set(MAIN_KEY, session.id);
  log.info(`main session ${session.shortId}`);
  return session;
}

/** Forget the main conversation; the next message starts a fresh one. */
export function resetMain() {
  const id = kv.get(MAIN_KEY);
  if (id) find(id)?.kill();
  kv.del(MAIN_KEY);
}

export interface SpawnTask {
  title: string;
  project?: string;
  threadId?: number | null;
  /** The session that asked for it; the task's reports go there as well as to the main conversation. */
  parent?: string | null;
}

/** A task session: its own topic, its own context. With a project it runs in that repo. */
export function spawnTask(opts: SpawnTask): Session {
  let kind: SessionKind = "task";
  let cwd = config.workspace;
  let project: string | undefined;
  if (opts.project) {
    const proj = getProject(opts.project);
    if (!proj) throw new Error(`unknown project: ${opts.project}`);
    kind = proj.kind === "repo" ? "code" : "task";
    cwd = proj.path;
    project = proj.slug;
  }
  const session = new Session({ kind, title: opts.title.trim() || UNTITLED, cwd, project, threadId: opts.threadId, parent: opts.parent });
  live.set(session.id, session);
  log.info(`spawned ${kind} ${session.shortId} "${opts.title}"`);
  prewarm("task");
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
    | { kind: SessionKind; title: string; cwd: string; project: string | null; thread_id: number | null; parent_id: string | null }
    | undefined;
  if (!row) return undefined;
  const session = new Session({
    kind: row.kind,
    title: row.title,
    cwd: workingDirectory(row.cwd, row.project),
    project: row.project ?? undefined,
    threadId: row.thread_id,
    parent: row.parent_id,
    resume: sessionId,
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
  const session = new Session({
    kind: project ? "code" : "task",
    title: title.slice(0, 80) || sessionId.slice(0, 8),
    cwd: workingDirectory(cwd, project?.slug ?? null),
    project: project?.slug,
    resume: sessionId,
  });
  live.set(session.id, session);
  log.info(`adopted ${session.shortId} "${session.title}" from ${cwd}`);
  bus.emitEvent("task.created", session.summary(), session.id);
  return session;
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
    kind: r.kind,
    title: r.title,
    project: r.project,
    cwd: r.cwd,
    threadId: r.thread_id,
    parent: r.parent_id ?? null,
    state: live.get(r.session_id)?.state ?? "detached",
    startedAt: r.started_at,
    lastActivity: r.last_activity,
    lastResult: r.last_result ?? "",
    costUsd: r.cost_usd,
    turns: r.turns,
    model: r.model ?? null,
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

/** Opens the main conversation and readies a process for the next task, so first replies are quick. */
export function warmUp() {
  main();
  prewarm("task");
}

/** Frees the subprocess of long-idle task sessions. The session itself stays resumable. */
export function reapIdle() {
  const cutoff = now() - config.idleShutdownMs;
  for (const s of live.values()) {
    if (s.state === "dead") {
      live.delete(s.id);
      continue;
    }
    if (s.kind === "main" || s.state !== "idle" || s.pending) continue;
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

/**
 * What tasks report becomes part of the main conversation, so "did it finish?"
 * needs no tool call and works regardless of which frontend was attached. A task started
 * by another session reports to that session too.
 */
export function relayTasksToMain() {
  bus.on("event", (e: PaiEvent) => {
    if (e.kind.startsWith("memory.")) rewarm("task");
    if (!e.sessionId) return;
    const s = find(e.sessionId);
    if (!s || s.kind === "main") return;
    const tag = `[task ${s.shortId} · ${s.title}]`;
    const mainId = kv.get(MAIN_KEY);
    const targets = new Set([mainId, s.parent].filter((id): id is string => Boolean(id)).map((id) => find(id)));
    for (const m of targets) {
      if (!m || m.state === "dead" || m === s) continue;
      if (e.kind === "memory.saved") {
        m.inject(`${tag} ${e.payload.updated ? "updated" : "saved"} memory ${e.payload.name} (${e.payload.type}): ${e.payload.description}`);
      } else if (e.kind === "memory.forgotten") {
        m.inject(`${tag} forgot memory ${e.payload.name}`);
      } else if (e.kind === "session.turn_end") {
        const text = String(e.payload.text ?? "").trim();
        if (text) m.inject(`${tag} reported:\n${text.slice(0, 1500)}`);
      } else if (e.kind === "session.question") {
        m.inject(`${tag} is waiting for the user to answer a question.`);
      } else if (e.kind === "session.error") {
        m.inject(`${tag} failed: ${e.payload.message}`);
      }
    }
  });
}
