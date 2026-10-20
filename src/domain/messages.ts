import { bus } from "../core/bus.ts";
import type { RichPlace } from "../protocol/rich.ts";
import { db, now } from "../core/db.ts";

/** The orchestrator's slug; its chat is the user's one chat. */
const PAI = "pai";

/**
 * The message log: every word that passes between the user, pai, its agents, routines and
 * watchers, one row each. An agent's chat in any client is this table filtered to that agent;
 * tool calls stay in the transcripts, so the log only holds what is said, and stays readable.
 * Each row is also told to the bus as `message.new`, which is how clients follow it live.
 */

/** Who says something: `user`, `pai`, an agent's slug, `routine:<id>` or `watcher:<source>`. */
export type Party = string;

export type MessageKind =
  /** The user and pai (or an agent) talking. */
  | "chat"
  /** Work handed down: pai to an agent, an agent to a sub-agent. */
  | "delegate"
  /** What an agent says back at the end of a turn. */
  | "report"
  /** An agent's need, routed by pai; and what came back. */
  | "request"
  | "response"
  /** A question for the user, and its answer. */
  | "ask"
  | "answer"
  | "notice"
  /** Something happened: an agent created, woken, closed, a routine fired, mail arrived. */
  | "event";

/** The events a client draws as one-line service rows, each with its own icon. */
export type EventName =
  | "agent.created"
  | "agent.spawned"
  | "agent.woken"
  | "agent.closed"
  | "agent.tools_missing"
  | "stopped"
  | "routine.fired"
  | "item.arrived"
  | "calendar.upcoming"
  | "answered"
  | "sent"
  /** The account's own limit stopped a turn; the work is held until the window reopens. */
  | "rate_limited"
  | "error";

export interface MessageMeta {
  event?: EventName;
  priority?: string;
  askId?: number;
  requestId?: number;
  /** For a delegation or a report: the agent the row is about, when neither end says it. */
  agent?: string;
  link?: string;
  /** Attachment names (`attachments.ts`) for the pictures the message came with. */
  images?: string[];
  /** A map pin: a client draws it as a place, Telegram as a venue. */
  place?: RichPlace;
  options?: string[];
  breadcrumb?: string;
  /** An answer's reply to the ask it answers: who asked, the ask's first line, and its row. */
  quote?: { from: string; excerpt: string; messageId?: number; at?: number };
  [key: string]: unknown;
}

export interface Message {
  readonly id: number;
  readonly from: Party;
  readonly to: Party;
  readonly kind: MessageKind;
  readonly body: string;
  readonly taskId: number | null;
  readonly meta: MessageMeta;
  readonly createdAt: number;
}

const toMessage = (r: Record<string, any>): Message => ({
  id: r.id,
  from: r.sender,
  to: r.recipient,
  kind: r.kind,
  body: r.body,
  taskId: r.task_id ?? null,
  meta: JSON.parse(r.meta || "{}") as MessageMeta,
  createdAt: r.created_at,
});

export interface LogInput {
  from: Party;
  to: Party;
  kind: MessageKind;
  body: string;
  taskId?: number | null;
  meta?: MessageMeta;
}

export function log(input: LogInput): Message {
  const at = now();
  const res = db
    .prepare("INSERT INTO messages (sender, recipient, kind, body, task_id, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(input.from, input.to, input.kind, input.body, input.taskId ?? null, JSON.stringify(input.meta ?? {}), at);
  const message: Message = { id: Number(res.lastInsertRowid), from: input.from, to: input.to, kind: input.kind, body: input.body, taskId: input.taskId ?? null, meta: input.meta ?? {}, createdAt: at };
  if (input.body.trim() && input.kind !== "event")
    db.prepare("INSERT INTO archive (source, ref, title, body, ts) VALUES ('message', ?, ?, ?, ?)").run(String(message.id), `${input.from} → ${input.to} (${input.kind})`, input.body, at);
  bus.emitEvent("message.new", message as unknown as Record<string, unknown>);
  return message;
}

/** An event row: who it is about, what happened, in a line. */
export const event = (about: Party, name: EventName, body: string, extra: Partial<LogInput> & { meta?: MessageMeta } = {}) =>
  log({ from: extra.from ?? about, to: extra.to ?? about, kind: "event", body, taskId: extra.taskId, meta: { ...extra.meta, event: name, agent: about } });

export interface ListOptions {
  /** One agent's chat: what it said, what was said to it, and events about it. */
  agent?: string;
  /** Rows older than this id, for paging back. */
  before?: number;
  /** Rows newer than this id, for catching up. */
  after?: number;
  limit?: number;
  kinds?: MessageKind[];
  /** One task's thread: every row about it, whoever wrote it. */
  task?: number;
}

export function list(opts: ListOptions = {}): Message[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (opts.agent === PAI) {
    // pai's chat is the user's one chat: every question put to the user, whoever asked it, and every answer, is in it.
    where.push("(sender = ? OR recipient = ? OR json_extract(meta, '$.agent') = ? OR (kind IN ('ask', 'answer') AND (recipient = 'user' OR sender = 'user')))");
    args.push(opts.agent, opts.agent, opts.agent);
  } else if (opts.agent) {
    where.push("(sender = ? OR recipient = ? OR json_extract(meta, '$.agent') = ?)");
    args.push(opts.agent, opts.agent, opts.agent);
  }
  if (opts.task) {
    where.push("task_id = ?");
    args.push(opts.task);
  }
  if (opts.before) {
    where.push("id < ?");
    args.push(opts.before);
  }
  if (opts.after) {
    where.push("id > ?");
    args.push(opts.after);
  }
  if (opts.kinds?.length) {
    where.push(`kind IN (${opts.kinds.map(() => "?").join(", ")})`);
    args.push(...opts.kinds);
  }
  const limit = Math.min(opts.limit ?? 100, 1000);
  const sql = `SELECT * FROM messages ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id ${opts.after ? "ASC" : "DESC"} LIMIT ?`;
  const rows = (db.query(sql).all(...args, limit) as Record<string, any>[]).map(toMessage);
  return opts.after ? rows : rows.reverse();
}

/**
 * A row whose content really does change: a draft card he edits is the same row, not a new one, so
 * every client redraws it in place. Only the few rows that are a live thing use this.
 */
export function update(id: number, patch: { body?: string; meta?: MessageMeta }): Message | undefined {
  const m = get(id);
  if (!m) return undefined;
  const body = patch.body ?? m.body;
  const meta = patch.meta ? { ...m.meta, ...patch.meta } : m.meta;
  db.prepare("UPDATE messages SET body = ?, meta = ? WHERE id = ?").run(body, JSON.stringify(meta), id);
  const updated = { ...m, body, meta };
  bus.emitEvent("message.updated", updated as unknown as Record<string, unknown>);
  return updated;
}

/** Adds to a message's metadata (a summary written later, say) and tells the bus the row changed. */
export function patchMeta(id: number, patch: MessageMeta): Message | undefined {
  const m = get(id);
  if (!m) return undefined;
  const meta = { ...m.meta, ...patch };
  db.prepare("UPDATE messages SET meta = ? WHERE id = ?").run(JSON.stringify(meta), id);
  const updated = { ...m, meta };
  bus.emitEvent("message.updated", updated as unknown as Record<string, unknown>);
  return updated;
}

export function get(id: number): Message | undefined {
  const row = db.query("SELECT * FROM messages WHERE id = ?").get(id) as Record<string, any> | undefined;
  return row ? toMessage(row) : undefined;
}

/** The conversation between the user and pai, newest last: what a rotated session is seeded with. */
export function chatWithPai(limit = 20): Message[] {
  return (
    db
      .query("SELECT * FROM messages WHERE kind = 'chat' AND ((sender = 'user' AND recipient = 'pai') OR (sender = 'pai' AND recipient = 'user')) ORDER BY id DESC LIMIT ?")
      .all(limit) as Record<string, any>[]
  )
    .map(toMessage)
    .reverse();
}

/** Rows since a moment, oldest first: what agents did overnight, for the morning brief. */
export function since(at: number, limit = 200): Message[] {
  return (db.query("SELECT * FROM messages WHERE created_at >= ? ORDER BY id DESC LIMIT ?").all(at, limit) as Record<string, any>[]).map(toMessage).reverse();
}
