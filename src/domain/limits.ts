/**
 * The account's own limit, as it actually arrives: not an error, but the turn's own reply text —
 * "You've hit your session limit · resets 5:10pm (UTC)". Treated as a message it looks like
 * something pai said, and the work the turn was doing is simply gone: on 19 October two agents
 * had to be re-sent their briefs by hand. So a turn that ends this way is held and sent again
 * after the window resets, and what the chat shows is an event, not a reply.
 */

const LIMIT = /\b(?:you'?ve|you have)\s+(?:hit|reached)\s+(?:your|the)\s+[\w-]*\s*limit\b|\busage limit reached\b/i;
/** "resets 5:10pm (UTC)", "resets at 17:10", "resets 5pm" — the time the window opens again. */
const RESET = /resets?\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i;
/** A retry exactly at the reset is refused again; this much past it is enough. */
export const MARGIN_MS = 60_000;
/** With no time in the text, the five-hour window is the shape of the thing we are waiting for. */
const BLIND_WAIT_MS = 20 * 60_000;

export const isLimit = (text: string) => LIMIT.test(text);

/**
 * When to try again, in epoch ms. The text says a wall-clock time in UTC (that is what the SDK
 * prints), so the answer is the next such instant from now, plus a margin.
 */
export function resetAt(text: string, now = Date.now()): number {
  const match = RESET.exec(text);
  if (!match) return now + BLIND_WAIT_MS;
  const hour12 = Number(match[1]);
  const minutes = Number(match[2] ?? 0);
  const suffix = match[3]?.toLowerCase();
  const hours = suffix === "pm" ? (hour12 % 12) + 12 : suffix === "am" ? hour12 % 12 : hour12;
  if (hours > 23 || minutes > 59) return now + BLIND_WAIT_MS;
  const at = new Date(now);
  at.setUTCHours(hours, minutes, 0, 0);
  // A time already past is tomorrow's: the window the text names is always the next one.
  if (at.getTime() <= now) at.setUTCDate(at.getUTCDate() + 1);
  return at.getTime() + MARGIN_MS;
}

/** What the chat says about it, in one line: the subject, and when the work goes on. */
export const limitLine = (who: string, at: number) => `${who} paused on the account's limit — picking it up again at ${new Date(at).toISOString().slice(11, 16)} UTC`;
