import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../core/config.ts";
import { logger } from "../core/log.ts";

/**
 * What a currency is worth, for showing an amount in the ones he actually thinks in. The source is
 * the European Central Bank through frankfurter.app: free, no key, one call a day. The answer is
 * cached on disk and served stale with its own date rather than not at all — a hover over an amount
 * must never wait for a network call, and yesterday's rate is the right answer to "about how much".
 */

const log = logger("rates");
/**
 * Two free sources, no key either side. The first carries 160+ currencies — the ECB's own list has
 * no UAH, and he has family in Ukraine — and the second is the ECB feed as a fallback.
 */
const SOURCES = ["https://open.er-api.com/v6/latest/EUR", "https://api.frankfurter.app/latest?base=EUR"];
/** A failed fetch is retried, backing off, rather than waiting for tomorrow's tick. */
const RETRY_MS = [30_000, 5 * 60_000, 30 * 60_000];
const file = join(dirname(config.dbPath), "rates.json");
const DAY_MS = 86_400_000;

export interface Rates {
  /** Everything is quoted against this one. */
  readonly base: string;
  /** The day the rates are from, as the source gives it. */
  readonly date: string;
  readonly rates: Readonly<Record<string, number>>;
  /** When they were fetched, so a client can say how old they are. */
  readonly at: number;
}

let held: Rates | undefined;
let fetching: Promise<Rates | undefined> | undefined;

async function stored(): Promise<Rates | undefined> {
  if (held) return held;
  if (!existsSync(file)) return undefined;
  try {
    held = (await Bun.file(file).json()) as Rates;
    return held;
  } catch {
    return undefined;
  }
}

async function fromSource(url: string): Promise<Rates | undefined> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) }).catch((err: Error) => {
    log.warn(`rates ${new URL(url).host}: ${err.message}`);
    return undefined;
  });
  if (!res?.ok) return undefined;
  const body = (await res.json().catch(() => undefined)) as { base?: string; base_code?: string; date?: string; time_last_update_utc?: string; rates?: Record<string, number> } | undefined;
  const base = body?.base ?? body?.base_code;
  if (!body?.rates || !base) return undefined;
  const date = body.date ?? (body.time_last_update_utc ? new Date(body.time_last_update_utc).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10));
  // The base itself is not always in the answer, and an amount in it must convert like any other.
  return { base, date, rates: { ...body.rates, [base]: 1 }, at: Date.now() };
}

async function refresh(): Promise<Rates | undefined> {
  for (const url of SOURCES) {
    const fresh = await fromSource(url);
    if (!fresh) continue;
    held = fresh;
    await Bun.write(file, JSON.stringify(held));
    log.info(`rates for ${held.date}, ${Object.keys(held.rates).length} currencies (${new URL(url).host})`);
    return held;
  }
  log.warn("no source answered; keeping what is on disk");
  return undefined;
}

/**
 * Asked for at start as well as daily, so a client is never offered an amount it cannot convert;
 * a failure backs off and tries again instead of waiting for tomorrow.
 */
export function startRates() {
  const timers: ReturnType<typeof setTimeout>[] = [];
  const attempt = async (tries = 0) => {
    const have = await rates();
    if (have && Date.now() - have.at < DAY_MS) return;
    const wait = RETRY_MS[Math.min(tries, RETRY_MS.length - 1)]!;
    timers.push(setTimeout(() => void attempt(tries + 1), wait));
  };
  void attempt();
  timers.push(setInterval(() => void attempt(), DAY_MS) as unknown as ReturnType<typeof setTimeout>);
  return () => timers.forEach((t) => clearTimeout(t));
}

/** The rates to answer with: the cached ones, refreshed in the background once they are a day old. */
export async function rates(): Promise<Rates | undefined> {
  const have = await stored();
  if (have && Date.now() - have.at < DAY_MS) return have;
  // A stale answer now beats a fresh one later; the fetch runs either way.
  fetching ??= refresh().finally(() => (fetching = undefined));
  return have ?? (await fetching);
}

/** `GET /rates`, with the currencies he keeps in view so one call tells a client everything it needs. */
export async function ratesResponse(): Promise<Response> {
  const current = await rates();
  const list = config.currencies;
  return Response.json(current ? { ...current, currencies: list } : { error: "no rates yet", currencies: list }, { status: current ? 200 : 503 });
}
