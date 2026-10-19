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
const SOURCE = "https://api.frankfurter.app/latest?base=EUR";
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

async function refresh(): Promise<Rates | undefined> {
  const res = await fetch(SOURCE, { signal: AbortSignal.timeout(10_000) }).catch((err: Error) => {
    log.warn(`rates: ${err.message}`);
    return undefined;
  });
  if (!res?.ok) return undefined;
  const body = (await res.json()) as { base?: string; date?: string; rates?: Record<string, number> };
  if (!body.rates || !body.base) return undefined;
  // The base itself is not in the answer, and an amount in it must convert like any other.
  held = { base: body.base, date: body.date ?? new Date().toISOString().slice(0, 10), rates: { ...body.rates, [body.base]: 1 }, at: Date.now() };
  await Bun.write(file, JSON.stringify(held));
  log.info(`rates for ${held.date}, ${Object.keys(held.rates).length} currencies`);
  return held;
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
