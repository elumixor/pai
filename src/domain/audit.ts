import { db, now } from "../core/db.ts";

/**
 * What the sessions did to the world, as opposed to what they read or thought: an email sent, a
 * LinkedIn reply, a calendar event moved, a click in a signed-in site. The event log has every tool
 * call, but only as a one-line summary among thousands of reads, and is useless for "what did pai send
 * to whom last week". A call counts when its tool name says it changes something (a verb from
 * `VERBS` among its words) or it acts inside a browser; pai's own bookkeeping (tasks, asks, memory,
 * other agents) stays out, since it changes nothing outside the daemon. The full input is kept, so
 * a row is enough to tell what went out; the result says whether it did.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS audit (
  tool_use_id  TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  agent        TEXT,
  tool         TEXT NOT NULL,
  summary      TEXT NOT NULL,
  input        TEXT NOT NULL,
  result       TEXT,
  ok           INTEGER,
  ts           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_ts ON audit(ts);
`);

const VERBS = new Set(
  "send reply forward post publish create update delete remove trash untrash share invite pay upload set add label unlabel mark sign draft move restore duplicate append insert batch write comment react accept withdraw follow like edit import start stop categorize clear copy".split(
    " ",
  ),
);
/** Acting inside a signed-in site; navigating, snapshots and scripts that mostly read stay out. */
const BROWSER = new Set(["browser_click", "browser_type", "browser_fill_form", "browser_file_upload", "browser_select_option", "browser_drag", "browser_drop"]);
/** Servers whose tools only touch the daemon's own state. */
const INTERNAL = new Set(["pai", "builder"]);
const BUILTIN = new Set(["Artifact"]);

const INPUT_MAX = 4000;
const RESULT_MAX = 500;

/** Whether a tool call changes something outside the daemon. */
export function outward(name: string): boolean {
  if (BUILTIN.has(name)) return true;
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (!m) return false;
  const [, server, tool] = m as unknown as [string, string, string];
  if (INTERNAL.has(server)) return false;
  if (server.endsWith("playwright")) return BROWSER.has(tool);
  return tool.split(/[-_]/).some((w) => VERBS.has(w.toLowerCase()));
}

export interface Entry {
  readonly toolUseId: string;
  readonly sessionId: string;
  readonly agent: string | null;
  readonly tool: string;
  readonly summary: string;
  readonly input: string;
  readonly result: string | null;
  /** null while the call has not answered. */
  readonly ok: boolean | null;
  readonly ts: number;
}

/** Notes a tool call when it is outward; anything else is ignored. */
export function record(call: { toolUseId: string; sessionId: string; agent: string | null; tool: string; summary: string; input: unknown }) {
  if (!outward(call.tool)) return;
  const input = JSON.stringify(call.input ?? {});
  db.prepare("INSERT OR IGNORE INTO audit (tool_use_id, session_id, agent, tool, summary, input, ts) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    call.toolUseId,
    call.sessionId,
    call.agent,
    call.tool,
    call.summary,
    input.length > INPUT_MAX ? `${input.slice(0, INPUT_MAX)}…` : input,
    now(),
  );
}

/** What a recorded call returned; a call that was never recorded is left alone. */
export function settle(toolUseId: string, result: string, isError: boolean) {
  db.prepare("UPDATE audit SET result = ?, ok = ? WHERE tool_use_id = ?").run(result.slice(0, RESULT_MAX), isError ? 0 : 1, toolUseId);
}

export function list(opts: { agent?: string; since?: number; limit?: number; search?: string } = {}): Entry[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (opts.agent) where.push("agent = ?"), args.push(opts.agent);
  if (opts.since) where.push("ts >= ?"), args.push(opts.since);
  if (opts.search) where.push("(summary LIKE ? OR input LIKE ?)"), args.push(`%${opts.search}%`, `%${opts.search}%`);
  const rows = db
    .query(`SELECT * FROM audit ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ts DESC LIMIT ?`)
    .all(...args, opts.limit ?? 50) as Record<string, string | number | null>[];
  return rows.map((r) => ({
    toolUseId: r.tool_use_id as string,
    sessionId: r.session_id as string,
    agent: r.agent as string | null,
    tool: r.tool as string,
    summary: r.summary as string,
    input: r.input as string,
    result: r.result as string | null,
    ok: r.ok === null ? null : r.ok === 1,
    ts: r.ts as number,
  }));
}
