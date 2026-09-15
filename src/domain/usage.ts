import { $ } from "bun";
import { homedir } from "node:os";
import { join } from "node:path";
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
  readonly error?: string;
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
async function accessToken(): Promise<string | undefined> {
  let raw: string | undefined;
  if (process.platform === "darwin") {
    const res = await $`security find-generic-password -s "Claude Code-credentials" -w`.nothrow().quiet();
    raw = res.exitCode === 0 ? res.stdout.toString() : undefined;
  }
  if (!raw) raw = await Bun.file(join(homedir(), ".claude", ".credentials.json")).text().catch(() => undefined);
  if (!raw) return undefined;
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
  if (usage.five_hour) out.push({ name: "Session", percent: Math.round(usage.five_hour.utilization), resetsAt: usage.five_hour.resets_at, length: SESSION_WINDOW });
  if (usage.seven_day) out.push({ name: "Weekly", percent: Math.round(usage.seven_day.utilization), resetsAt: usage.seven_day.resets_at, length: WEEKLY_WINDOW });
  for (const limit of usage.limits ?? [])
    if (limit.kind === "weekly_scoped" && limit.scope?.model)
      out.push({ name: limit.scope.model.display_name ?? "Model", percent: Math.round(limit.percent), resetsAt: limit.resets_at, length: WEEKLY_WINDOW });
  for (const [key, value] of Object.entries(usage)) {
    if (!key.startsWith("seven_day_") || !value || typeof value !== "object" || key === "seven_day_oauth_apps") continue;
    const period = value as Period;
    const name = titleCase(key.slice("seven_day_".length));
    if (!out.some((w) => w.name.toLowerCase() === name.toLowerCase())) out.push({ name, percent: Math.round(period.utilization), resetsAt: period.resets_at, length: WEEKLY_WINDOW });
  }
  return out;
}

let cached: { at: number; windows: readonly Window[]; fetchedAt?: string; error?: string } | undefined;

async function fetchWindows(): Promise<Omit<NonNullable<typeof cached>, "at">> {
  const token = await accessToken();
  if (!token) return { windows: [], error: "no Claude Code login on this machine" };
  const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: { authorization: `Bearer ${token}`, accept: "application/json", "anthropic-beta": "oauth-2025-04-20" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`usage api: ${response.status}`);
  return { windows: windows((await response.json()) as OauthUsage), fetchedAt: new Date().toISOString() };
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
      cached = { at: Date.now(), windows: cached?.windows ?? [], fetchedAt: cached?.fetchedAt, error: (err as Error).message };
    }
  }
  const { windows: known, fetchedAt, error } = cached!;
  return { windows: known, fetchedAt, error, costUsd: sessionCost() };
}
