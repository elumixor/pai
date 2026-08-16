import { Session } from "./session.ts";
import { db, now } from "./db.ts";
import { config } from "./config.ts";
import { get as getProject } from "./catalog.ts";
import { logger } from "./log.ts";

const log = logger("sessions");

const live = new Map<string, Session>();

export function spawn(project: string, title = ""): Session {
  const proj = getProject(project);
  if (!proj) throw new Error(`unknown project: ${project}`);
  const session = new Session({ project: proj.slug, cwd: proj.path, title });
  live.set(session.id, session);
  log.info(`spawned ${session.shortId} in ${proj.slug}`);
  return session;
}

export function find(idOrShort: string): Session | undefined {
  const exact = live.get(idOrShort);
  if (exact) return exact;
  return [...live.values()].find((s) => s.shortId === idOrShort || s.id.startsWith(idOrShort));
}

/** Resumes a session whose process died but whose transcript is still on disk. */
export function revive(sessionId: string): Session | undefined {
  const row = db.query("SELECT * FROM sessions WHERE session_id = ?").get(sessionId) as
    | { project: string; cwd: string; title: string }
    | undefined;
  if (!row) return undefined;
  const session = new Session({ project: row.project, cwd: row.cwd, title: row.title, resume: sessionId });
  live.set(session.id, session);
  log.info(`revived ${session.shortId} in ${row.project}`);
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

function resolveId(idOrShort: string): string | undefined {
  const row = db
    .query("SELECT session_id FROM sessions WHERE session_id = ? OR short_id = ? ORDER BY last_activity DESC LIMIT 1")
    .get(idOrShort, idOrShort) as { session_id: string } | undefined;
  return row?.session_id;
}

export function list() {
  return [...live.values()].map((s) => s.toJSON());
}

/** Sessions builder owns, plus every other Claude Code session running on this machine. */
export async function listAll() {
  let foreign: Record<string, unknown>[] = [];
  try {
    const proc = Bun.spawn(["claude", "agents", "--json"], { stdout: "pipe", stderr: "ignore" });
    foreign = JSON.parse(await new Response(proc.stdout).text()) as Record<string, unknown>[];
  } catch (err) {
    log.debug("claude agents --json failed", (err as Error).message);
  }
  const owned = list();
  const ownedIds = new Set(owned.map((s) => s.sessionId));
  return {
    owned,
    foreign: foreign.filter((f) => !ownedIds.has(f.sessionId as string)),
  };
}

/** Recent sessions per project, for router context. */
export function recentByProject(project?: string, limit = 10) {
  const rows = project
    ? (db
        .query("SELECT * FROM sessions WHERE project = ? ORDER BY last_activity DESC LIMIT ?")
        .all(project, limit) as Record<string, string | number>[])
    : (db.query("SELECT * FROM sessions ORDER BY last_activity DESC LIMIT ?").all(limit) as Record<
        string,
        string | number
      >[]);
  return rows.map((r) => ({
    sessionId: r.session_id as string,
    shortId: r.short_id as string,
    project: r.project as string,
    title: r.title as string,
    state: (live.get(r.session_id as string)?.state ?? (r.state === "dead" ? "dead" : "detached")) as string,
    lastActivity: r.last_activity as number,
    lastResult: (r.last_result as string) ?? "",
  }));
}

export function killAll() {
  for (const s of live.values()) s.kill();
  live.clear();
}

/** Frees the subprocess of long-idle sessions. The session itself stays resumable. */
export function reapIdle() {
  const cutoff = now() - config.session.idleShutdownMs;
  for (const s of live.values()) {
    const row = db.query("SELECT last_activity FROM sessions WHERE session_id = ?").get(s.id) as
      | { last_activity: number }
      | undefined;
    if (s.state === "idle" && row && row.last_activity < cutoff) {
      log.info(`reaping idle ${s.shortId}`);
      s.kill();
      live.delete(s.id);
    }
    if (s.state === "dead") live.delete(s.id);
  }
}
