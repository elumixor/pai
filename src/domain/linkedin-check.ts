/**
 * Does pai still see LinkedIn? A signed-in session and a dead one look identical from the inbox:
 * nothing arrives either way, and the ten phantom sends of 6 October were exactly that — the page
 * said yes, the account never heard it, and nine people waited two weeks. The state changes without
 * announcing itself in both directions (it signed itself back in overnight, too), so the observer
 * watches both edges and lives outside the module: its own liveness must not depend on LinkedIn,
 * the browser, or the poller it is watching.
 */
import { db, kv } from "../core/db.ts";
import { logger } from "../core/log.ts";
import * as external from "../modules/external.ts";
import * as watch from "./watch.ts";

const log = logger("linkedin");
const NAME = "linkedin";
const EVENT = "linkedin.message";

/** The poller runs every five minutes; this only has to notice a fault that lasts hours. */
const EVERY_MS = 30 * 60_000;
/** The first look, late enough that the module has started and polled once. */
const FIRST_MS = 3 * 60_000;
/** A read is late after this many of the module's own intervals, and never sooner than half an hour. */
const LATE_POLLS = 3;
const LATE_FLOOR_MS = 30 * 60_000;
/** The module's default, used when he has not set one. */
const POLL_EVERY_MS = 5 * 60_000;
/** Even in a quiet month, this much nothing is worth a question. */
const QUIET_FLOOR_MS = 36 * 3600_000;
/** How far back "normal for him" is measured. */
const WINDOW_MS = 30 * 24 * 3600_000;

export interface Signal {
  /** The module answered its own status route; false when it is installed but did not start. */
  readonly answering: boolean;
  /** Whether the browser session is signed in; undefined when it could not be asked. */
  readonly signedIn?: boolean;
  readonly lastPollAt?: number;
  readonly pollOk?: boolean;
  readonly pollError?: string;
  readonly pollEveryMs: number;
  /** How long this daemon has been up: before its first poll, "never read" means nothing. */
  readonly upMs: number;
  /** The newest `linkedin.message` event. */
  readonly lastMessageAt?: number;
  /** The longest completed quiet stretch in the window — what his normal traffic looks like. */
  readonly longestGapMs?: number;
}

const hours = (ms: number) => `${Math.round(ms / 3600_000)}h`;
const mins = (ms: number) => `${Math.round(ms / 60_000)} min`;

/**
 * Why LinkedIn looks dead, in the words the task carries; undefined while it looks alive. Both edges
 * are faults: a session that cannot read, and a session that reads and has heard nothing for longer
 * than his own traffic ever goes quiet — from the inside those are the same picture.
 */
export function unwell(s: Readonly<Signal>, nowMs = Date.now()): string | undefined {
  if (!s.answering)
    return `the LinkedIn module did not answer its own status route within ${ASK_TIMEOUT_MS / 1000}s. Either it never started, or the browser page it reads through is wedged — a dead page makes its callers hang rather than fail, so from here the two look the same.`;
  if (s.signedIn === false)
    return `LinkedIn is signed out${s.lastPollAt ? `; the inbox was last read ${hours(nowMs - s.lastPollAt)} ago` : ""}. Nothing arrives until the session is captured again: \`pai browser login linkedin\` on the Mac.`;
  const late = Math.max(LATE_POLLS * s.pollEveryMs, LATE_FLOOR_MS);
  if (s.pollOk === false) return `the last LinkedIn inbox read failed${s.pollError ? ` (${s.pollError})` : ""}, ${s.lastPollAt ? mins(nowMs - s.lastPollAt) : "an unknown time"} ago.`;
  if (!s.lastPollAt) return s.upMs > late ? `LinkedIn has not been read once in the ${mins(s.upMs)} since pai started, though the poller is set to every ${mins(s.pollEveryMs)}.` : undefined;
  if (nowMs - s.lastPollAt > late) return `the LinkedIn inbox has not been read for ${mins(nowMs - s.lastPollAt)}, though the poller is set to every ${mins(s.pollEveryMs)}.`;
  if (s.lastMessageAt === undefined) return undefined;
  const quiet = nowMs - s.lastMessageAt;
  const normal = s.longestGapMs ?? 0;
  if (quiet <= Math.max(QUIET_FLOOR_MS, normal)) return undefined;
  return `the LinkedIn session reads fine, but nothing has arrived in ${hours(quiet)} — the longest quiet stretch in the month before that was ${hours(normal)}. Either his inbox is genuinely still or the poller stopped seeing it, and from the inside those look the same.`;
}

export const TITLE = "pai may have stopped seeing LinkedIn";
const NEXT_ACTION = "Run `pai linkedin status`; if it is signed out, `pai browser login linkedin` on the Mac captures the session again";

/** One task, its reason kept current, closed by the check itself when LinkedIn answers again. */
export const report = (reason: string | undefined, nowMs = Date.now()) =>
  watch.keep({ title: TITLE, nextAction: NEXT_ACTION, by: "linkedin-check" }, reason, nowMs);

/** What his LinkedIn traffic has looked like: the newest message, and the worst quiet stretch before it. */
export function traffic(nowMs = Date.now()) {
  const rows = db.query(`SELECT ts FROM events WHERE kind = ? AND ts > ? ORDER BY ts`).all(EVENT, nowMs - WINDOW_MS) as { ts: number }[];
  let longestGapMs = 0;
  for (let i = 1; i < rows.length; i++) longestGapMs = Math.max(longestGapMs, rows[i]!.ts - rows[i - 1]!.ts);
  return { lastMessageAt: rows.at(-1)?.ts, longestGapMs: longestGapMs || undefined };
}

/**
 * Asking the module costs a cookie check and a live read, both through the one page a site has, and
 * that page serves one caller at a time — so a healthy answer can queue behind the poller. This has
 * to stay well above the module's own caps, or a slow answer is reported as a dead module: the first
 * look after v0.6.31 said "it never started" about a module that answered in six seconds.
 */
const ASK_TIMEOUT_MS = 45_000;

interface Status {
  readonly signedIn?: boolean;
  readonly lastPoll?: { at: string; ok: boolean; error?: string };
}

async function status(): Promise<Status | undefined> {
  const url = new URL(`http://pai/m/${NAME}/status`);
  const answer = await Promise.race([
    external.route(new Request(url.toString()), url).catch(() => undefined),
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ASK_TIMEOUT_MS)),
  ]);
  return answer?.ok ? ((await answer.json()) as Status) : undefined;
}

/**
 * The check. A read it could not make says nothing at all — an open task stays open and the next
 * round looks again — because "I could not ask" is not "it is fine".
 */
export async function checkLinkedIn(nowMs = Date.now()) {
  // No LinkedIn to watch: a task claiming pai cannot see it would be noise, so any open one resolves.
  if (!external.isInstalled(NAME)) return report(undefined);
  const s = await status();
  const pollAt = s?.lastPoll ? Date.parse(s.lastPoll.at) : undefined;
  report(
    unwell(
      {
        answering: Boolean(s),
        signedIn: s?.signedIn,
        lastPollAt: Number.isFinite(pollAt) ? pollAt : undefined,
        pollOk: s?.lastPoll?.ok,
        pollError: s?.lastPoll?.error,
        pollEveryMs: Math.max(Number(kv.get(`module:${NAME}:interval`) ?? 0) * 60_000, POLL_EVERY_MS),
        upMs: process.uptime() * 1000,
        ...traffic(nowMs),
      },
      nowMs,
    ),
    nowMs,
  );
}

/** Its own timer, deliberately: an observer that shares a loop with what it watches dies with it. */
export function startLinkedInCheck() {
  const tick = () => void checkLinkedIn().catch((err: Error) => log.warn(`check: ${err.message}`));
  const first = setTimeout(tick, FIRST_MS);
  const timer = setInterval(tick, EVERY_MS);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
