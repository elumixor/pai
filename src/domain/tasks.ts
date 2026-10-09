import { bus } from "../core/bus.ts";
import { db, now } from "../core/db.ts";

/**
 * The one task list: what the user has on their plate. pai's database is the source of truth;
 * Notion pages and GitHub issues are links on a task (`source`), kept current by the agent that
 * owns it, never a store this syncs with. Every task has an owner agent (`pai` until routed).
 */

export const STATUSES = ["inbox", "active", "waiting_user", "waiting_other", "scheduled", "done", "dropped"] as const;
export type TaskStatus = (typeof STATUSES)[number];

/** Statuses that are still on the plate. */
export const OPEN: readonly TaskStatus[] = ["inbox", "active", "waiting_user", "waiting_other", "scheduled"];

export interface Task {
  readonly id: number;
  readonly title: string;
  readonly parentId: number | null;
  readonly owner: string;
  readonly status: TaskStatus;
  readonly nextAction: string;
  /** `YYYY-MM-DD`, in the user's zone. */
  readonly due: string | null;
  /** A Notion page, a GitHub issue, an email thread. */
  readonly source: string | null;
  readonly notes: string;
  /** `user`, `pai`, an agent, or `sync`/`event` for what arrived on its own. */
  readonly createdBy: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

const toTask = (r: Record<string, any>): Task => ({
  id: r.id,
  title: r.title,
  parentId: r.parent_id ?? null,
  owner: r.owner,
  status: r.status,
  nextAction: r.next_action,
  due: r.due ?? null,
  source: r.source ?? null,
  notes: r.notes,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class TaskError extends Error {}

/**
 * The first link in a piece of text, markdown or bare. A task whose next action is "book a slot
 * at <url>" is one tap on a phone only if something hands that url to the card.
 */
export function firstUrl(...texts: readonly (string | null | undefined)[]): string | undefined {
  for (const text of texts) {
    const markdown = /\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/.exec(text ?? "");
    if (markdown) return markdown[1];
    // Trailing punctuation belongs to the sentence, not to the url.
    const bare = /https?:\/\/[^\s<>"')]+/.exec(text ?? "");
    if (bare) return bare[0].replace(/[.,;:!?]+$/, "");
  }
  return undefined;
}

function checkStatus(status: string | undefined): TaskStatus | undefined {
  if (status === undefined) return undefined;
  if (!(STATUSES as readonly string[]).includes(status)) throw new TaskError(`status is one of ${STATUSES.join(", ")}`);
  return status as TaskStatus;
}

function checkDue(due: string | null | undefined) {
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new TaskError("due is a date, YYYY-MM-DD");
  return due;
}

export interface TaskInput {
  title: string;
  parentId?: number | null;
  owner?: string;
  status?: TaskStatus;
  nextAction?: string;
  due?: string | null;
  source?: string | null;
  notes?: string;
  createdBy?: string;
}

export function get(id: number): Task | undefined {
  const row = db.query("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, any> | undefined;
  return row ? toTask(row) : undefined;
}

export function add(input: TaskInput): Task {
  if (!input.title?.trim()) throw new TaskError("a task needs a title");
  if (input.parentId && !get(input.parentId)) throw new TaskError(`no task #${input.parentId}`);
  const at = now();
  const res = db
    .prepare("INSERT INTO tasks (title, parent_id, owner, status, next_action, due, source, notes, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(input.title.trim(), input.parentId ?? null, input.owner ?? "pai", checkStatus(input.status) ?? "inbox", input.nextAction ?? "", checkDue(input.due) ?? null, input.source ?? null, input.notes ?? "", input.createdBy ?? "pai", at, at);
  const task = get(Number(res.lastInsertRowid))!;
  bus.emitEvent("task.added", task as unknown as Record<string, unknown>);
  return task;
}

export type TaskChanges = Partial<Omit<TaskInput, "createdBy">>;

export function update(id: number, changes: TaskChanges): Task {
  const current = get(id);
  if (!current) throw new TaskError(`no task #${id}`);
  if (changes.parentId === id) throw new TaskError("a task cannot be its own parent");
  const next = {
    title: changes.title?.trim() || current.title,
    parent_id: changes.parentId === undefined ? current.parentId : changes.parentId,
    owner: changes.owner ?? current.owner,
    status: checkStatus(changes.status) ?? current.status,
    next_action: changes.nextAction ?? current.nextAction,
    due: changes.due === undefined ? current.due : (checkDue(changes.due) ?? null),
    source: changes.source === undefined ? current.source : changes.source,
    notes: changes.notes ?? current.notes,
  };
  db.prepare("UPDATE tasks SET title = ?, parent_id = ?, owner = ?, status = ?, next_action = ?, due = ?, source = ?, notes = ?, updated_at = ? WHERE id = ?").run(
    next.title,
    next.parent_id,
    next.owner,
    next.status,
    next.next_action,
    next.due,
    next.source,
    next.notes,
    now(),
    id,
  );
  const task = get(id)!;
  bus.emitEvent("task.updated", { ...task, previous: current.status } as unknown as Record<string, unknown>);
  return task;
}

export interface ListOptions {
  owner?: string;
  status?: TaskStatus | TaskStatus[];
  /** Only what is still on the plate; the default. */
  open?: boolean;
  parentId?: number;
  limit?: number;
}

export function list(opts: ListOptions = {}): Task[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  const statuses = opts.status ? (Array.isArray(opts.status) ? opts.status : [opts.status]) : opts.open === false ? [] : OPEN;
  if (statuses.length) {
    where.push(`status IN (${statuses.map(() => "?").join(", ")})`);
    args.push(...statuses);
  }
  if (opts.owner) {
    where.push("owner = ?");
    args.push(opts.owner);
  }
  if (opts.parentId !== undefined) {
    where.push("parent_id = ?");
    args.push(opts.parentId);
  }
  // Waiting on the user first, then what is due soonest, then what moved last.
  const sql = `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY CASE status WHEN 'waiting_user' THEN 0 WHEN 'active' THEN 1 WHEN 'inbox' THEN 2 ELSE 3 END, due IS NULL, due, updated_at DESC LIMIT ?`;
  return (db.query(sql).all(...args, opts.limit ?? 200) as Record<string, any>[]).map(toTask);
}

/** Tasks done or dropped since a moment: "what did you do today". */
export function closedSince(at: number): Task[] {
  return (db.query("SELECT * FROM tasks WHERE status IN ('done', 'dropped') AND updated_at >= ? ORDER BY updated_at DESC").all(at) as Record<string, any>[]).map(toTask);
}

/** Open tasks that have not moved for a while: "what is stuck". */
export function stale(olderThanMs = 3 * 24 * 3600 * 1000): Task[] {
  return list().filter((t) => t.status !== "scheduled" && now() - t.updatedAt > olderThanMs);
}

/** One line per task, for a prompt or a terminal. */
export function line(t: Task) {
  const bits = [`#${t.id}`, t.title, `[${t.status}]`, `owner ${t.owner}`];
  if (t.due) bits.push(`due ${t.due}`);
  if (t.nextAction) bits.push(`next: ${t.nextAction}`);
  if (t.source) bits.push(t.source);
  return bits.join(" · ");
}

/** Count of open tasks per owner, for the agent tree. */
export function openCounts(): Record<string, number> {
  const rows = db.query(`SELECT owner, COUNT(*) AS n FROM tasks WHERE status IN (${OPEN.map(() => "?").join(", ")}) GROUP BY owner`).all(...OPEN) as { owner: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.owner, r.n]));
}
