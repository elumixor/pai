import { db, now } from "../core/db.ts";
import { logger } from "../core/log.ts";
import { pageId } from "./keep.ts";

/**
 * Which pai thread owns which Keep page (one page = one thread): notifications about a page go to its thread.
 * `observe` sees every tool call a session makes and `settle` its result, so a Keep `watch` that worked links its page.
 */

const log = logger("keep-links");

/** `keep:page/<id>` for an id or a URN. */
export const pageUrn = (page: string) => `keep:page/${pageId(page.trim())}`;

/** The owner is gone: its session row is, or it was a closed agent's (as `people-notify.targetOf` sees it). */
const STALE = `NOT EXISTS (SELECT 1 FROM sessions s WHERE s.session_id = keep_threads.session_id
  AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.slug = s.agent AND a.status = 'closed'))`;

/** Makes the session own the page; the first live thread to claim one keeps it unless `replace`. Whether it owns it now. */
export function link(page: string, sessionId: string, opts: { replace?: boolean; title?: string } = {}): boolean {
  const urn = pageUrn(page);
  const take = "DO UPDATE SET session_id = excluded.session_id, title = excluded.title, linked_at = excluded.linked_at";
  const conflict = opts.replace ? take : `${take} WHERE ${STALE}`;
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

/** Keep `watch` calls waiting for their result, by tool_use id; bounded, since a cut-off turn never answers. */
const pending = new Map<string, { sessionId: string; action: "watch" | "unwatch"; page: string }>();
const MAX_PENDING = 100;

/** A session's tool call: a Keep `watch` is held until `settle` says it worked. Never throws, whatever the input. */
export function observe(sessionId: string, tool: string, input: unknown, toolUseId: string): void {
  if (tool !== "mcp__keep__watch") return;
  const { action, page_id } = (input ?? {}) as { action?: unknown; page_id?: unknown };
  if (typeof page_id !== "string" || !page_id.trim() || (action !== "watch" && action !== "unwatch")) return;
  pending.set(toolUseId, { sessionId, action, page: page_id });
  if (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value as string);
}

/** A tool call's result: a Keep `watch` that worked links (or, unwatching, unlinks) its page. Never throws. */
export function settle(toolUseId: string, isError: boolean): void {
  const call = pending.get(toolUseId);
  if (!call) return;
  pending.delete(toolUseId);
  if (isError) return;
  try {
    if (call.action === "watch") link(call.page, call.sessionId);
    else unlink(call.page, call.sessionId);
  } catch (err) {
    log.warn(`settle ${call.action} ${call.page}: ${(err as Error).message}`);
  }
}
