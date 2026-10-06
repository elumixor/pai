import { now } from "../core/db.ts";
import { stamp } from "../core/time.ts";
import * as agents from "./agents.ts";
import * as asks from "./asks.ts";
import * as messages from "./messages.ts";
import * as tasks from "./tasks.ts";

/**
 * The two briefs. The morning one is a turn for pai with everything it needs laid out (what is
 * waiting on the user, what the agents did overnight, the digest); pai adds today's calendar
 * and writes it as one message. The evening one is the digest alone, put together by code.
 */

const NIGHT_MS = 14 * 3600 * 1000;

/** What agents did since last evening, one line per report or closing. */
function overnight(): string[] {
  return messages
    .since(now() - NIGHT_MS)
    .filter((m) => m.kind === "report" || (m.kind === "event" && (m.meta.event === "agent.created" || m.meta.event === "agent.closed" || m.meta.event === "error")))
    .map((m) => `- ${stamp(m.createdAt).slice(11)} ${agents.get(m.from)?.name ?? m.from}: ${m.body.replace(/\s+/g, " ").slice(0, 200)}`);
}

export function morning(): string {
  const waiting = asks.open();
  const old = new Set(asks.stale().map((a) => a.id));
  const digest = asks.takeDigest();
  const due = tasks.list().filter((t) => t.due && t.due <= stamp().slice(0, 10));
  const work = overnight();
  return [
    "[morning brief] Write the user's morning brief as one short message: today's calendar (Balance's list_events), what is waiting on them, what the agents did overnight, and the digest folded into a line or two. Skip empty parts. No preamble.",
    `Waiting on the user (${waiting.length}):\n${waiting.map((a) => `- #${a.id} ${agents.breadcrumb(a.agent)}: ${a.question}${old.has(a.id) ? " (open for over a day — repeat it)" : ""}`).join("\n") || "nothing"}`,
    `Due today or overdue:\n${due.map(tasks.line).join("\n") || "nothing"}`,
    `Agents overnight:\n${work.join("\n") || "nothing"}`,
    `Digest (${digest.length}):\n${asks.digestText(digest) || "nothing"}`,
  ].join("\n\n");
}

/** The evening digest, or nothing when there is none. */
export function evening(): string {
  const digest = asks.takeDigest();
  return digest.length ? `Digest — ${digest.length} thing${digest.length === 1 ? "" : "s"} today, none needing you:\n${asks.digestText(digest)}` : "";
}
