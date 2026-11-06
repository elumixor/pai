import { randomUUID } from "node:crypto";
import { bus } from "../core/bus.ts";
import { api } from "../connectors/loader.ts";
import { db, now } from "../core/db.ts";

/**
 * What came in (mail, chats, meetings, Keep's notifications through People) and what Pai did with it, one row each.
 * Triage records an item when it arrives and settles it with its decision; People's notifications are settled with
 * where they were routed. All of it is kept for the record, but the user's inbox shows only what was addressed to
 * Pai: pages assigned or shared to it and mentions of it. The mail and chats Pai merely saw go by are not theirs to read.
 */

export type Action = "pending" | "ignored" | "muted" | "filed" | "woke" | "told" | "routed" | "failed";

/** What the inbox shows: what someone addressed to Pai. */
const ADDRESSED = `kind IN ('keep.mention', 'keep.share', 'keep.invite')`;
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
  /** Where its words live (`itemText`); a row with one keeps no body once it is set aside. */
  readonly ref: string | null;
}

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
  ref: string | null;
}

const entryOf = (r: Row): Entry => ({ ...r, readAt: r.read_at });
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
  readonly ref?: Record<string, unknown>;
}): string {
  const id = input.id ?? randomUUID();
  db.prepare("DELETE FROM inbox WHERE at < ?").run(now() - KEEP_MS);
  db.prepare("INSERT OR IGNORE INTO inbox (id, source, kind, title, body, link, at, action, target, note, ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    id,
    input.source,
    input.kind,
    input.title.slice(0, 300),
    input.ref && input.action === "muted" ? "" : (input.body ?? "").slice(0, MAX_BODY),
    input.link ?? null,
    input.at ?? now(),
    input.action ?? "pending",
    input.target ?? null,
    input.note ?? null,
    input.ref ? JSON.stringify(input.ref) : null,
  );
  changed(id);
  return id;
}

/** What Pai did with it. */
export function settle(id: string | undefined, outcome: { readonly action: Action; readonly target?: string | null; readonly note?: string | null }) {
  if (!id) return;
  const setAside = outcome.action === "ignored" || outcome.action === "muted";
  db.prepare("UPDATE inbox SET action = ?, target = ?, note = ?, body = CASE WHEN ? AND ref IS NOT NULL THEN '' ELSE body END WHERE id = ?").run(outcome.action, outcome.target ?? null, outcome.note?.slice(0, 300) ?? null, setAside ? 1 : 0, id);
  changed(id);
}

/** What triage acted on, newest first, a page at a time. */
export function triaged(limit = 100, before = now() + 1): readonly Entry[] {
  const rows = db.query(`SELECT * FROM inbox WHERE NOT (${ADDRESSED}) AND action NOT IN ('ignored', 'muted') AND at < ? ORDER BY at DESC LIMIT ?`).all(before, Math.max(1, Math.min(500, limit))) as Row[];
  return rows.map(entryOf);
}

/** Everything triage saw in a stretch of time, set aside or not (muted is never shown), newest first. */
export const between = (from: number, to: number): readonly Entry[] =>
  (db.query(`SELECT * FROM inbox WHERE NOT (${ADDRESSED}) AND action != 'muted' AND at BETWEEN ? AND ? ORDER BY at DESC LIMIT 500`).all(from, to) as Row[]).map(entryOf);

const CONNECTOR_OF: Readonly<Record<string, string>> = { mail: "email", telegram: "telegram", whatsapp: "whatsapp" };

/** An item's words, read from where they live; what the row kept when the source cannot answer. */
export async function itemText(entry: Entry): Promise<string> {
  const connector = CONNECTOR_OF[entry.source];
  const reader = connector && entry.ref ? api<{ readItem?: (ref: unknown) => Promise<string | undefined> }>(connector)?.readItem : undefined;
  if (!reader) return entry.body;
  try {
    return (await reader(JSON.parse(entry.ref!))) || entry.body;
  } catch {
    return entry.body;
  }
}

/** Once: notices triage sent before they said so, recognised by the item they name, so they fold with the rest. */
export function tagOldTriageNotices() {
  if (db.query("SELECT 1 FROM kv WHERE key = 'triage_notices_tagged'").get()) return;
  db.exec(`UPDATE messages SET meta = json_set(meta, '$.triage', 'legacy')
    WHERE kind = 'notice' AND sender = 'pai' AND ifnull(json_extract(meta, '$.priority'), '') != 'urgent' AND EXISTS (
      SELECT 1 FROM inbox i WHERE i.action = 'told' AND i.at BETWEEN messages.created_at - 900000 AND messages.created_at
        AND (instr(messages.body, i.title) > 0 OR (i.link IS NOT NULL AND instr(messages.body, i.link) > 0) OR (i.note IS NOT NULL AND instr(messages.body, i.note) > 0)))`);
  db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('triage_notices_tagged', '1')").run();
}

export const get = (id: string) => {
  const row = db.query("SELECT * FROM inbox WHERE id = ?").get(id) as Row | null;
  return row ? entryOf(row) : undefined;
};

/** What triage was still deciding when the daemon stopped: its batch is memory only. */
export const undecided = (): readonly Entry[] => (db.query(`SELECT * FROM inbox WHERE action = 'pending' AND NOT (${ADDRESSED}) ORDER BY at`).all() as Row[]).map(entryOf);

/** What was addressed to Pai, newest first. */
export function list(limit = 100): { readonly items: readonly Entry[]; readonly unread: number } {
  const rows = db.query(`SELECT * FROM inbox WHERE ${ADDRESSED} ORDER BY at DESC LIMIT ?`).all(Math.max(1, Math.min(500, limit))) as Row[];
  return { items: rows.map(entryOf), unread: unread() };
}

export const unread = () => (db.query(`SELECT count(*) AS n FROM inbox WHERE read_at IS NULL AND ${ADDRESSED}`).get() as { n: number }).n;

/** Marks these read, or every one when none are named. */
export function read(ids?: readonly string[]) {
  const at = now();
  if (ids?.length) {
    const update = db.prepare("UPDATE inbox SET read_at = ? WHERE id = ? AND read_at IS NULL");
    for (const id of ids) update.run(at, id);
  } else db.prepare(`UPDATE inbox SET read_at = ? WHERE read_at IS NULL AND ${ADDRESSED}`).run(at);
  changed();
  return { unread: unread() };
}
