/**
 * Did the release arrive? `pai dev release` waits for `/health` to report the tag, but what it waits for is a
 * restart that kills it: twice in one day the verifier died with the daemon it was watching, and a release that
 * never lands looks exactly like one that did. A check that lives inside the thing it checks proves nothing when
 * that thing dies, so this one looks from the other side — the daemon is the observer that outlives the release.
 * A `v*` tag older than the time CI needs, with this checkout still behind it, is a release that did not arrive.
 */
import { $ } from "bun";
import { config, setting } from "../core/config.ts";
import { logger } from "../core/log.ts";
import { status, type UpdateStatus } from "./update.ts";
import { keep } from "./watch.ts";

/** CI delivers in five to seven minutes; past this a release is late, not in flight. */
export const GRACE_MS = 15 * 60_000;
/** Its own timer, outside core's auto-update: an observer sharing a loop with what it watches dies with it. */
const EVERY_MS = 10 * 60_000;
const FIRST_LOOK_MS = 2 * 60_000;

/** What the decision needs: the newest tag, how far behind this checkout is, and whether it is someone's workbench. */
export type Lag = Pick<UpdateStatus, "target" | "behind" | "dirty" | "head">;

/**
 * Why the newest release looks stuck, in the words the task carries; undefined while all is well.
 * The age comes from the tag itself rather than from a timer, so it survives the restart that a
 * release causes and cannot be reset by one.
 */
export function overdue(lag: Readonly<Lag>, taggedAtMs: number | undefined, nowMs = Date.now(), graceMs = GRACE_MS): string | undefined {
  if (!lag.target || lag.behind === 0) return undefined;
  // A dirty checkout is someone mid-work: being behind is their choice, not a failed delivery.
  if (lag.dirty || !taggedAtMs) return undefined;
  const age = nowMs - taggedAtMs;
  if (age < graceMs) return undefined;
  const commits = `${lag.behind} commit${lag.behind === 1 ? "" : "s"}`;
  return `${lag.target} was tagged ${Math.round(age / 60_000)} minutes ago and this daemon is still on ${lag.head}, ${commits} behind. CI normally delivers in 5–7 minutes, so either the build failed or it never reached the host.`;
}

const TITLE = "A release has not reached the daemon";
const NEXT_ACTION = "Check the CI run for that tag, then `pai update` (`pai dev update --force` on the box builds it there)";

/** When the tag was cut, in milliseconds; undefined when git cannot say. */
async function taggedAt(repo: string, tag: string): Promise<number | undefined> {
  const out = await $`git log -1 --format=%ct ${tag}`.cwd(repo).nothrow().quiet();
  const seconds = Number(out.stdout.toString().trim());
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

/**
 * One look. The state is read again before alarming: an update applied between the read and the raise is a real
 * race, since the delivery restarts this process. The all-clear needs no confirming. Only the tag channel follows
 * releases; on a branch "behind" is just unpulled work.
 */
async function check() {
  if (setting("PAI_UPDATE_CHANNEL") !== "tag") return;
  // One task, its reason kept current — the tag and the minutes are in it, so "CI is slow" reads differently from "nothing arrived".
  const raise = (reason: string | undefined) => keep({ title: TITLE, nextAction: NEXT_ACTION, by: "release-check" }, reason);
  const lag = await status();
  const reason = overdue(lag, lag.target ? await taggedAt(config.repo, lag.target) : undefined);
  if (reason && (await status()).behind === 0) return raise(undefined);
  raise(reason);
}

/** Looks now and then, even while sessions are busy: it only reads, so it can never interrupt a turn. */
const log = logger("release-check");

export function startReleaseCheck() {
  const tick = () => check().catch((err: Error) => log.warn(`release check: ${err.message}`));
  const first = setTimeout(tick, FIRST_LOOK_MS);
  const timer = setInterval(tick, EVERY_MS);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
