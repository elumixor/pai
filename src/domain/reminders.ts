import { config } from "../core/config.ts";
import { db, now } from "../core/db.ts";
import { logger } from "../core/log.ts";
import { quiet } from "../core/time.ts";
import * as agents from "./agents.ts";
import * as asks from "./asks.ts";
import { needs } from "./needs.ts";

/**
 * What waits on the user is said again until it is settled: a question that reached them, a question a session has
 * open, an agent they stopped and left. Drafts and tasks have cards and the brief, and ask for nothing by a deadline.
 */

const log = logger("reminders");
const REMINDED = new Set(["ask", "question", "paused"]);
const MINUTE = 60_000;

interface Reminder {
  readonly need: string;
  readonly at: number;
  readonly times: number;
}

/** Those due now get a line each. Quiet hours hold them; they are due the moment it ends. */
export function remindDue() {
  const open = needs().filter((n) => REMINDED.has(n.kind));
  const ids = new Set(open.map((n) => n.id));
  const rows = db.query("SELECT need, at, times FROM reminders").all() as Reminder[];
  for (const r of rows) if (!ids.has(r.need)) db.prepare("DELETE FROM reminders WHERE need = ?").run(r.need);
  if (quiet()) return;
  const said = new Map(rows.map((r) => [r.need, r]));
  for (const n of open) {
    const last = said.get(n.id);
    const due = last ? last.at + config.remindRepeatMinutes * MINUTE : n.createdAt + config.remindMinutes * MINUTE;
    if (now() < due) continue;
    const excerpt = n.question.replace(/\s+/g, " ").slice(0, 200);
    asks.remind(n.agent ?? agents.PAI, `Still waiting on you: ${excerpt}`);
    db.prepare("INSERT INTO reminders (need, at, times) VALUES (?, ?, ?) ON CONFLICT(need) DO UPDATE SET at = excluded.at, times = times + 1").run(n.id, now(), 1);
    log.info(`reminded of ${n.id}`);
  }
}
