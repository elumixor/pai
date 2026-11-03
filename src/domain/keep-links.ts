import { db, now } from "../core/db.ts";
import { logger } from "../core/log.ts";
import { pageId } from "./keep.ts";

/**
 * Which pai thread owns which Keep page (one page = one thread): notifications about a page go to its thread.
 * `observe` sees every tool call a session makes, so Keep's `watch` can link the page it watches.
 */

const log = logger("keep-links");

/** `keep:page/<id>` for an id or a URN. */
export const pageUrn = (page: string) => `keep:page/${pageId(page.trim())}`;

/** Makes the session own the page; the first thread to claim one keeps it unless `replace`. Whether it owns it now. */
export function link(page: string, sessionId: string, opts: { replace?: boolean; title?: string } = {}): boolean {
  const urn = pageUrn(page);
  const conflict = opts.replace ? "DO UPDATE SET session_id = excluded.session_id, title = excluded.title, linked_at = excluded.linked_at" : "DO NOTHING";
  db.prepare(`INSERT INTO keep_threads (page_urn, session_id, title, linked_at) VALUES (?, ?, ?, ?) ON CONFLICT(page_urn) ${conflict}`).run(urn, sessionId, opts.title ?? "", now());
  return threadFor(urn) === sessionId;
}

/** Gives the page up; with a session, only when that session owns it. */
export function unlink(page: string, sessionId?: string) {
  const urn = pageUrn(page);
  if (sessionId) db.prepare("DELETE FROM keep_threads WHERE page_urn = ? AND session_id = ?").run(urn, sessionId);
  else db.prepare("DELETE FROM keep_threads WHERE page_urn = ?").run(urn);
}

/** The session owning the page. */
export function threadFor(page: string): string | undefined {
  return (db.query("SELECT session_id FROM keep_threads WHERE page_urn = ?").get(pageUrn(page)) as { session_id: string } | undefined)?.session_id;
}

/** The pages a session owns. */
export function pagesOf(sessionId: string): { page_urn: string; title: string }[] {
  return db.query("SELECT page_urn, title FROM keep_threads WHERE session_id = ? ORDER BY linked_at").all(sessionId) as { page_urn: string; title: string }[];
}

/** A session's tool call: Keep's `watch` links (or, unwatching, unlinks) its page. Never throws, whatever the input. */
export function observe(sessionId: string, tool: string, input: unknown): void {
  if (tool !== "mcp__keep__watch") return;
  try {
    const { action, page_id } = (input ?? {}) as { action?: unknown; page_id?: unknown };
    if (typeof page_id !== "string" || !page_id.trim()) return;
    if (action === "watch") link(page_id, sessionId);
    else if (action === "unwatch") unlink(page_id, sessionId);
  } catch (err) {
    log.warn(`observe ${tool}: ${(err as Error).message}`);
  }
}
