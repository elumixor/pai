import { $ } from "bun";
import { hostname, homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { logger } from "../core/log.ts";
import { list, recent } from "./sessions.ts";

const log = logger("usage");

/**
 * The Claude subscription's limits, as the menu bar shows them: the five-hour session
 * window and the model-scoped weekly window. Read with the Claude Code login on this
 * machine, so every client can show the same rings without a login of its own.
 */

export interface Window {
  readonly name: string;
  readonly percent: number;
  readonly resetsAt?: string;
  /** Length of the window in seconds, so a client can draw how much of it is left. */
  readonly length: number;
}

export interface Usage {
  readonly windows: readonly Window[];
  /** What the sessions the daemon knows about have cost, as the SDK reports it. */
  readonly costUsd: number;
  readonly fetchedAt?: string;
  /** The machine whose login answered, when it was not this one. */
  readonly via?: string;
  readonly error?: string;
}

/**
 * A daemon whose login can read the limits leaves the answer in the transcripts folder,
 * which sync carries to the other machines; a daemon whose token cannot (the box logs in
 * with a setup token, which has no `user:profile`) shows that copy instead. The account is
 * the same, so the limits are.
 */
const SNAPSHOT = join(homedir(), ".claude", "projects", ".pai", "usage.json");
const SNAPSHOT_MAX_AGE = 36 * 3600 * 1000;

interface Snapshot {
  windows: Window[];
  fetchedAt: string;
  host: string;
}

async function writeSnapshot(windows: Window[], fetchedAt: string) {
  try {
    mkdirSync(dirname(SNAPSHOT), { recursive: true });
    await Bun.write(SNAPSHOT, JSON.stringify({ windows, fetchedAt, host: hostname() } satisfies Snapshot));
  } catch (err) {
    log.debug(`snapshot not written: ${(err as Error).message}`);
  }
}

async function readSnapshot(): Promise<Snapshot | undefined> {
  try {
    const snapshot = (await Bun.file(SNAPSHOT).json()) as Snapshot;
    if (snapshot.host === hostname() || Date.now() - Date.parse(snapshot.fetchedAt) > SNAPSHOT_MAX_AGE) return undefined;
    return snapshot;
  } catch {
    return undefined;
  }
}

const SESSION_WINDOW = 5 * 3600;
const WEEKLY_WINDOW = 7 * 24 * 3600;
/** The endpoint rate-limits per login, and the menu bar app asks it too, so ask rarely and back off when told to. */
const TTL = 2 * 60 * 1000;
const BACKOFF = 5 * 60 * 1000;

interface Period {
  utilization: number;
  resets_at?: string;
}

interface OauthUsage extends Record<string, unknown> {
  five_hour?: Period;
  seven_day?: Period;
  limits?: { kind: string; percent: number; resets_at?: string; scope?: { model?: { display_name?: string } } }[];
}

const titleCase = (s: string) => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Claude Code keeps its OAuth token in the login keychain on macOS and in
 * `~/.claude/.credentials.json` elsewhere; the `security` CLI reads the keychain
 * without an access-control dialog.
 */
export async function accessToken(): Promise<string | undefined> {
  let raw: string | undefined;
  if (process.platform === "darwin") {
    const res = await $`security find-generic-password -s "Claude Code-credentials" -w`.nothrow().quiet();
    raw = res.exitCode === 0 ? res.stdout.toString() : undefined;
  }
  if (!raw) raw = await Bun.file(join(homedir(), ".claude", ".credentials.json")).text().catch(() => undefined);
  // A headless host logs in with a long-lived token in the environment instead of a keychain.
  if (!raw) return process.env.CLAUDE_CODE_OAUTH_TOKEN || undefined;
  try {
    return (JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } }).claudeAiOauth?.accessToken;
  } catch {
    return undefined;
  }
}

/**
 * Every window the API reports: the five-hour session, the general week, each model-scoped
 * week (`limits`, and the older `seven_day_<model>` fields). The client picks which to show.
 */
function windows(usage: OauthUsage): Window[] {
  const out: Window[] = [];
  if (typeof usage.five_hour?.utilization === "number") out.push({ name: "Session", percent: Math.round(usage.five_hour.utilization), resetsAt: usage.five_hour.resets_at, length: SESSION_WINDOW });
  if (typeof usage.seven_day?.utilization === "number") out.push({ name: "Weekly", percent: Math.round(usage.seven_day.utilization), resetsAt: usage.seven_day.resets_at, length: WEEKLY_WINDOW });
  for (const limit of usage.limits ?? [])
    if (limit.kind === "weekly_scoped" && limit.scope?.model)
      out.push({ name: limit.scope.model.display_name ?? "Model", percent: Math.round(limit.percent), resetsAt: limit.resets_at, length: WEEKLY_WINDOW });
  for (const [key, value] of Object.entries(usage)) {
    if (!key.startsWith("seven_day_") || !value || typeof value !== "object" || key === "seven_day_oauth_apps") continue;
    const period = value as Period;
    if (typeof period.utilization !== "number") continue;
    const name = titleCase(key.slice("seven_day_".length));
    if (!out.some((w) => w.name.toLowerCase() === name.toLowerCase())) out.push({ name, percent: Math.round(period.utilization), resetsAt: period.resets_at, length: WEEKLY_WINDOW });
  }
  return out;
}

let cached: { at: number; windows: readonly Window[]; fetchedAt?: string; via?: string; error?: string } | undefined;

/** A token the endpoint refused (a setup token: 403, then 429 for asking again) is left alone for a while. */
let tokenRefusedUntil = 0;

/** Whether the limits could be read with a login of this machine's own, as a client decides whether to hand one over. */
export const needsLogin = () => Boolean(cached?.error) || Date.now() < tokenRefusedUntil;
const REFUSED_FOR = 60 * 60 * 1000;

async function fetchWindows(): Promise<Omit<NonNullable<typeof cached>, "at">> {
  const token = await accessToken();
  if (!token) return fromSnapshot("no Claude Code login on this machine");
  if (Date.now() < tokenRefusedUntil) return fromSnapshot("this machine's token cannot read the limits");
  const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: { authorization: `Bearer ${token}`, accept: "application/json", "anthropic-beta": "oauth-2025-04-20" },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 403 || response.status === 429) {
    tokenRefusedUntil = Date.now() + REFUSED_FOR;
    return fromSnapshot(`this machine's token cannot read the limits (${response.status})`);
  }
  if (!response.ok) return fromSnapshot(`usage api: ${response.status}`);
  const fetchedAt = new Date().toISOString();
  const found = windows((await response.json()) as OauthUsage);
  await writeSnapshot(found, fetchedAt);
  return { windows: found, fetchedAt };
}

async function fromSnapshot(reason: string): Promise<Omit<NonNullable<typeof cached>, "at">> {
  const snapshot = await readSnapshot();
  if (!snapshot) return { windows: [], error: `${reason}, and no other machine has shared its reading yet` };
  return { windows: snapshot.windows, fetchedAt: snapshot.fetchedAt, via: snapshot.host };
}

const sessionCost = () => {
  const live = list();
  const all = [...live, ...recent(50).filter((r) => !live.some((l) => l.shortId === r.shortId))];
  return Math.round(all.reduce((sum, s) => sum + (s.costUsd ?? 0), 0) * 100) / 100;
};

export async function usage(): Promise<Usage> {
  const stale = !cached || Date.now() - cached.at > (cached.error ? BACKOFF : TTL);
  if (stale) {
    try {
      cached = { at: Date.now(), ...(await fetchWindows()) };
    } catch (err) {
      log.warn(`usage: ${(err as Error).message}`);
      // The last good answer stays up, marked with the error, rather than an empty status line.
      cached = { at: Date.now(), windows: cached?.windows ?? [], fetchedAt: cached?.fetchedAt, via: cached?.via, error: (err as Error).message };
    }
  }
  const { windows: known, fetchedAt, via, error } = cached!;
  return { windows: known, fetchedAt, via, error, costUsd: sessionCost() };
}

/**
 * The subscription itself: the login's tier, read from its profile and priced. Like the limits,
 * a machine whose token cannot read it (the box's setup token) uses another machine's reading.
 */
export interface Plan {
  readonly tier: string;
  readonly monthlyUsd: number;
}

const PLAN_SNAPSHOT = join(dirname(SNAPSHOT), "plan.json");
/** Monthly list price per tier; a tier not listed is priced as the nearest by name. */
const TIER_USD: [match: RegExp, usd: number][] = [
  [/max_20x/, 200],
  [/max/, 100],
  [/pro/, 20],
];
let planCache: { at: number; plan?: Plan } | undefined;

export async function plan(): Promise<Plan | undefined> {
  if (planCache && Date.now() - planCache.at < 24 * 3600 * 1000 && planCache.plan) return planCache.plan;
  let found: Plan | undefined;
  const token = await accessToken();
  if (token && Date.now() >= tokenRefusedUntil) {
    const response = await fetch("https://api.anthropic.com/api/oauth/profile", {
      headers: { authorization: `Bearer ${token}`, accept: "application/json", "anthropic-beta": "oauth-2025-04-20" },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);
    const tier = response?.ok ? ((await response.json()) as { organization?: { rate_limit_tier?: string } }).organization?.rate_limit_tier : undefined;
    const usd = tier ? TIER_USD.find(([match]) => match.test(tier))?.[1] : undefined;
    if (tier && usd) {
      found = { tier, monthlyUsd: usd };
      await Bun.write(PLAN_SNAPSHOT, JSON.stringify(found)).catch(() => undefined);
    }
  }
  found ??= await Bun.file(PLAN_SNAPSHOT).json().catch(() => undefined);
  planCache = { at: Date.now(), plan: found };
  return found;
}
