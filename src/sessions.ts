import { Session, closeWarm, prewarm, rewarm, type SessionKind } from "./session.ts";
import { db, kv, now } from "./db.ts";
import { config } from "./config.ts";
import { bus, type PaiEvent } from "./bus.ts";
import { get as getProject } from "./catalog.ts";
import { logger } from "./log.ts";

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
}

/** A task session: its own topic, its own context. With a project it runs in that repo. */
export function spawnTask(opts: SpawnTask): Session {
  let kind: SessionKind = "task";
  let cwd = config.workspace;
  let project: string | undefined;
  if (opts.project) {
    const proj = getProject(opts.project);
    if (!proj) throw new Error(`unknown project: ${opts.project}`);
    kind = "code";
    cwd = proj.path;
    project = proj.slug;
  }
  const session = new Session({ kind, title: opts.title, cwd, project, threadId: opts.threadId });
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

/** Resumes a session whose process died but whose transcript is still on disk. */
export function revive(sessionId: string): Session | undefined {
  const row = db.query("SELECT * FROM sessions WHERE session_id = ?").get(sessionId) as
    | { kind: SessionKind; title: string; cwd: string; project: string | null; thread_id: number | null }
    | undefined;
  if (!row) return undefined;
  const session = new Session({
    kind: row.kind,
    title: row.title,
    cwd: row.cwd,
    project: row.project ?? undefined,
    threadId: row.thread_id,
    resume: sessionId,
  });
  live.set(session.id, session);
  log.info(`revived ${session.shortId} "${row.title}"`);
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
  threadId: number | null;
  state: string;
  startedAt: number;
  lastActivity: number;
  lastResult: string;
  costUsd: number;
  turns: number;
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
    threadId: r.thread_id,
    state: live.get(r.session_id)?.state ?? "detached",
    startedAt: r.started_at,
    lastActivity: r.last_activity,
    lastResult: r.last_result ?? "",
    costUsd: r.cost_usd,
    turns: r.turns,
  }));
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
 * needs no tool call and works regardless of which frontend was attached.
 */
export function relayTasksToMain() {
  bus.on("event", (e: PaiEvent) => {
    if (e.kind.startsWith("memory.")) rewarm("task");
    if (!e.sessionId) return;
    const s = find(e.sessionId);
    if (!s || s.kind === "main") return;
    const tag = `[task ${s.shortId} · ${s.title}]`;
    const mainId = kv.get(MAIN_KEY);
    const m = mainId ? find(mainId) : undefined;
    if (!m || m.state === "dead") return;
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
  });
}
