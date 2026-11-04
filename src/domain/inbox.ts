import { randomUUID } from "node:crypto";
import { bus } from "../core/bus.ts";
import { db, now } from "../core/db.ts";

/**
 * Pai's inbox: what came in (mail, chats, meetings, Keep's notifications through People) and what Pai did with it,
 * one row each, so he can see what it reacted to and how. Triage records an item when it arrives and settles it with
 * its decision; People's notifications are settled with where they were routed. "Relevant" leaves out what Pai
 * ignored or muted; the unread count is of the relevant ones.
 */

export type Action = "pending" | "ignored" | "muted" | "filed" | "woke" | "told" | "routed" | "failed";

/** What is kept for the record but needs nothing: left out of "Relevant" and of the unread count. */
const QUIET: readonly Action[] = ["ignored", "muted"];
/** Rows older than this are dropped as new ones come in. */
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BODY = 2000;

export interface Entry {
  readonly id: string;
  readonly source: string;
  readonly kind: string;
  readonly title: string;
  readonly body: string;
  readonly link: string | null;
  readonly at: number;
  readonly action: Action;
  /** `main`, `agent:<slug>`, `thread:<session id>` or `task:<id>`. */
  readonly target: string | null;
  readonly note: string | null;
  readonly readAt: number | null;
}

export type Filter = "relevant" | "all";

interface Row {
  id: string;
  source: string;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  at: number;
  action: Action;
  target: string | null;
  note: string | null;
  read_at: number | null;
}

const entryOf = (r: Row): Entry => ({ ...r, readAt: r.read_at });
const quietList = QUIET.map((a) => `'${a}'`).join(", ");
const changed = (id?: string) => bus.emitEvent("inbox.changed", id ? { id } : {});

/** Something that came in; its id (a given one is kept, so a retry of the same notification stays one row). */
export function record(input: {
  readonly id?: string;
  readonly source: string;
  readonly kind: string;
  readonly title: string;
  readonly body?: string;
  readonly link?: string | null;
  readonly at?: number;
  readonly action?: Action;
  readonly target?: string | null;
  readonly note?: string | null;
}): string {
  const id = input.id ?? randomUUID();
  db.prepare("DELETE FROM inbox WHERE at < ?").run(now() - KEEP_MS);
  db.prepare("INSERT OR IGNORE INTO inbox (id, source, kind, title, body, link, at, action, target, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    id,
    input.source,
    input.kind,
    input.title.slice(0, 300),
    (input.body ?? "").slice(0, MAX_BODY),
    input.link ?? null,
    input.at ?? now(),
    input.action ?? "pending",
    input.target ?? null,
    input.note ?? null,
  );
  changed(id);
  return id;
}

/** What Pai did with it. */
export function settle(id: string | undefined, outcome: { readonly action: Action; readonly target?: string | null; readonly note?: string | null }) {
  if (!id) return;
  db.prepare("UPDATE inbox SET action = ?, target = ?, note = ? WHERE id = ?").run(outcome.action, outcome.target ?? null, outcome.note?.slice(0, 300) ?? null, id);
  changed(id);
}

/** The newest first; `relevant` leaves out what needed nothing. */
export function list(filter: Filter = "relevant", limit = 100): { readonly items: readonly Entry[]; readonly unread: number } {
  const where = filter === "relevant" ? `WHERE action NOT IN (${quietList})` : "";
  const rows = db.query(`SELECT * FROM inbox ${where} ORDER BY at DESC LIMIT ?`).all(Math.max(1, Math.min(500, limit))) as Row[];
  return { items: rows.map(entryOf), unread: unread() };
}

export const unread = () =>
  (db.query(`SELECT count(*) AS n FROM inbox WHERE read_at IS NULL AND action NOT IN (${quietList})`).get() as { n: number }).n;

/** Marks these read, or every one when none are named. */
export function read(ids?: readonly string[]) {
  const at = now();
  if (ids?.length) {
    const update = db.prepare("UPDATE inbox SET read_at = ? WHERE id = ? AND read_at IS NULL");
    for (const id of ids) update.run(at, id);
  } else db.prepare("UPDATE inbox SET read_at = ? WHERE read_at IS NULL").run(at);
  changed();
  return { unread: unread() };
}
