import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { bus, type PaiEvent } from "../core/bus.ts";
import { config } from "../core/config.ts";
import { db, now } from "../core/db.ts";
import { logger } from "../core/log.ts";
import { cost as hostingCost } from "./hetzner.ts";
import { rates } from "./rates.ts";

/**
 * Where the time, the tokens and the money go. Every model call lands here as one row: each
 * Claude Code API response read out of the transcripts (the daemon's sessions, his terminals on
 * the Mac and the box, their sub-agents — one source, so nothing is counted twice and a restart
 * loses nothing), calls on the plan's API credits, and the gateway's metered calls. A row is priced
 * at API list rates, which is what the work would cost without the subscription; the report then
 * puts the real price next to it: the plan's monthly fee for the period, spread over what used
 * it, plus whatever was metered.
 */

const log = logger("spend");
const projectsDir = process.env.PAI_CLAUDE_PROJECTS ?? join(homedir(), ".claude", "projects");
const SCAN_MS = 60_000;
/** Read at most this much of one transcript per pass, so a first scan of months of history never holds it all at once. */
const CHUNK = 8 * 1024 * 1024;
const DAY_MS = 86_400_000;
const MONTH_DAYS = 30.44;

db.exec(`
CREATE TABLE IF NOT EXISTS spend (
  ref          TEXT PRIMARY KEY,         -- msg:<api message id> | turn:<id> | <source>:<id>
  ts           INTEGER NOT NULL,
  source       TEXT NOT NULL,            -- daemon | terminal | gateway | credits
  billing      TEXT NOT NULL,            -- subscription | metered | credits
  session_id   TEXT,
  cwd          TEXT,
  agent        TEXT,
  model        TEXT,
  input        INTEGER NOT NULL DEFAULT 0,
  output       INTEGER NOT NULL DEFAULT 0,
  cache_read   INTEGER NOT NULL DEFAULT 0,
  cache_write  INTEGER NOT NULL DEFAULT 0,
  cost_usd     REAL NOT NULL DEFAULT 0,
  ms           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS spend_ts ON spend(ts);
CREATE TABLE IF NOT EXISTS spend_files (
  path    TEXT PRIMARY KEY,
  offset  INTEGER NOT NULL
);
`);

// ---- prices -------------------------------------------------------------------------------

/** USD per million tokens: input, output, cache read. A cache write is 1.25× input for 5 minutes, 2× for an hour. */
const PRICES: [prefix: string, input: number, output: number, cacheRead: number][] = [
  ["claude-fable-5-1", 10, 50, 0.25],
  ["claude-mythos-5-1", 10, 50, 0.25],
  ["claude-fable-5", 10, 50, 1],
  ["claude-mythos", 10, 50, 1],
  ["claude-opus-5-5", 4, 20, 0.2],
  ["claude-opus-5", 5, 25, 0.5],
  ["claude-opus-4-8", 5, 25, 0.5],
  ["claude-opus-4-7", 5, 25, 0.5],
  ["claude-opus-4-6", 5, 25, 0.5],
  ["claude-opus-4-5", 5, 25, 0.5],
  ["claude-opus-4", 15, 75, 1.5],
  ["claude-sonnet-5", 2, 10, 0.2],
  ["claude-sonnet-4", 3, 15, 0.3],
  ["claude-haiku-5", 0.1, 0.5, 0.01],
  ["claude-haiku-4", 1, 5, 0.1],
  ["claude-3-5-haiku", 0.8, 4, 0.08],
  ["google/gemini-2.5-flash-lite", 0.1, 0.4, 0.025],
];
/** What an unknown model is priced at: the default model's rates. */
const FALLBACK = PRICES.find((p) => p[0] === "claude-opus-5-5")!;

export interface Tokens {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  /** Cache writes for five minutes and for an hour, priced differently. */
  readonly cacheWrite5m: number;
  readonly cacheWrite1h: number;
}

export function price(model: string, t: Tokens, fast = false): number {
  const [, input, output, cacheRead] = PRICES.find(([prefix]) => model.startsWith(prefix)) ?? FALLBACK;
  const usd = (t.input * input + t.output * output + t.cacheRead * cacheRead + t.cacheWrite5m * input * 1.25 + t.cacheWrite1h * input * 2) / 1e6;
  return fast ? usd * 2 : usd;
}

// ---- recording ----------------------------------------------------------------------------

export interface Row {
  readonly ref: string;
  readonly ts: number;
  readonly source: "daemon" | "terminal" | "gateway" | "credits";
  readonly billing: "subscription" | "metered" | "credits";
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly agent?: string;
  readonly model?: string;
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly costUsd?: number;
  readonly ms?: number;
}

/**
 * One row; the same ref again replaces it, keeping the larger counts — a streamed response is
 * written to the transcript once per content block, each carrying the usage so far.
 */
export function record(r: Row) {
  db.prepare(
    `INSERT INTO spend (ref, ts, source, billing, session_id, cwd, agent, model, input, output, cache_read, cache_write, cost_usd, ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(ref) DO UPDATE SET input = max(input, excluded.input), output = max(output, excluded.output),
       cache_read = max(cache_read, excluded.cache_read), cache_write = max(cache_write, excluded.cache_write),
       cost_usd = max(cost_usd, excluded.cost_usd), ms = max(ms, excluded.ms)`,
  ).run(r.ref, r.ts, r.source, r.billing, r.sessionId ?? null, r.cwd ?? null, r.agent ?? null, r.model ?? null, r.input ?? 0, r.output ?? 0, r.cacheRead ?? 0, r.cacheWrite ?? 0, r.costUsd ?? 0, r.ms ?? 0);
}

/** A gateway call (OpenAI-shaped `usage`), metered: its own reported cost when it gives one, else the price table's. */
export function recordGateway(model: string, usage: { prompt_tokens?: number; completion_tokens?: number; cost?: number } | undefined, ms: number, what: string) {
  const input = usage?.prompt_tokens ?? 0;
  const output = usage?.completion_tokens ?? 0;
  const costUsd = typeof usage?.cost === "number" ? usage.cost : price(model, { input, output, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
  record({ ref: `gateway:${what}:${crypto.randomUUID()}`, ts: now(), source: "gateway", billing: "metered", model, input, output, costUsd, ms, agent: what });
}

interface Usage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null;
  speed?: string | null;
}

export function tokensOf(u: Usage): Tokens {
  const write = u.cache_creation_input_tokens ?? 0;
  const hour = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  return { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite1h: hour, cacheWrite5m: Math.max(0, write - hour) };
}

// ---- transcripts --------------------------------------------------------------------------

interface Entry {
  type?: string;
  subtype?: string;
  uuid?: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  entrypoint?: string;
  durationMs?: number;
  message?: { id?: string; model?: string; usage?: Usage };
}

const sourceOf = (e: Entry): Row["source"] => (e.entrypoint?.startsWith("sdk") ? "daemon" : "terminal");

/** One transcript line into a row: an API response (by its message id) or a terminal turn's duration. */
export function fromEntry(e: Entry): Row | undefined {
  const ts = e.timestamp ? Date.parse(e.timestamp) : now();
  const base = { ts, source: sourceOf(e), billing: "subscription" as const, sessionId: e.sessionId, cwd: e.cwd };
  if (e.type === "assistant" && e.message?.id && e.message.usage && e.message.model && e.message.model !== "<synthetic>") {
    const t = tokensOf(e.message.usage);
    return { ...base, ref: `msg:${e.message.id}`, model: e.message.model, input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite5m + t.cacheWrite1h, costUsd: price(e.message.model, t, e.message.usage.speed === "fast") };
  }
  // The daemon's turns are timed from its own events; a terminal's only from its transcript.
  if (e.type === "system" && e.subtype === "turn_duration" && e.uuid && e.durationMs && base.source === "terminal") return { ...base, ref: `turn:${e.uuid}`, ms: e.durationMs };
  return undefined;
}

function* transcripts(dir: string): Generator<string> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const path = join(dir, name);
    if (name.endsWith(".jsonl")) yield path;
    else if (!name.includes(".")) yield* transcripts(path);
  }
}

const offsetOf = db.prepare("SELECT offset FROM spend_files WHERE path = ?");
const setOffset = db.prepare("INSERT INTO spend_files (path, offset) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET offset = excluded.offset");

/** Reads what each transcript gained since the last pass; returns how many rows it touched. */
export function scan(dir = projectsDir): number {
  if (!existsSync(dir)) return 0;
  let rows = 0;
  for (const path of transcripts(dir)) {
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      continue;
    }
    let offset = (offsetOf.get(path) as { offset: number } | undefined)?.offset ?? 0;
    // A file that shrank was rewritten; read it again (refs make that idempotent).
    if (size < offset) offset = 0;
    while (offset < size) {
      const length = Math.min(CHUNK, size - offset);
      const buf = Buffer.alloc(length);
      const fd = openSync(path, "r");
      try {
        readSync(fd, buf, 0, length, offset);
      } finally {
        closeSync(fd);
      }
      const last = buf.lastIndexOf(0x0a);
      // A line still being written waits for the next pass.
      if (last < 0) break;
      const lines = buf.subarray(0, last).toString("utf8").split("\n");
      db.transaction(() => {
        for (const line of lines) {
          if (!line.includes('"usage"') && !line.includes("turn_duration")) continue;
          let row: Row | undefined;
          try {
            row = fromEntry(JSON.parse(line) as Entry);
          } catch {
            continue;
          }
          if (!row) continue;
          record(row);
          rows += 1;
        }
      })();
      offset += last + 1;
      setOffset.run(path, offset);
    }
  }
  return rows;
}

/** The daemon's own turns, timed as they end; their tokens arrive through the transcript. */
function onTurn(e: PaiEvent) {
  if (e.kind !== "session.turn_end" || !e.sessionId || e.payload.terminal) return;
  const ms = Number(e.payload.durationMs ?? 0);
  if (!ms) return;
  record({ ref: `turn:${e.sessionId}:${e.ts}`, ts: e.ts, source: "daemon", billing: "subscription", sessionId: e.sessionId, agent: typeof e.payload.agent === "string" ? e.payload.agent : undefined, ms });
}

export function start() {
  const pass = () => {
    try {
      const n = scan();
      if (n) log.debug(`${n} rows from transcripts`);
    } catch (err) {
      log.warn(`scan: ${(err as Error).message}`);
    }
  };
  // The first pass may read months of history; it waits until the daemon is up.
  const first = setTimeout(pass, 5_000);
  const timer = setInterval(pass, SCAN_MS);
  bus.on("event", onTurn);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
    bus.off("event", onTurn);
  };
}

// ---- report -------------------------------------------------------------------------------

export interface Bucket {
  readonly key: string;
  /** What it would cost at API list prices. */
  apiUsd: number;
  /** What it actually costs: its share of the plan, plus what was metered. */
  realUsd: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Wall-clock time spent in turns. */
  ms: number;
  calls: number;
}

export interface Report {
  readonly from: number;
  readonly to: number;
  readonly days: number;
  readonly plan: { readonly monthlyUsd: number; readonly periodUsd: number; readonly tier?: string };
  /** The plan's monthly API credits: what this period drew from them, and a month's grant (Max includes its own price). */
  readonly credits: { readonly usedUsd: number; readonly monthlyUsd: number };
  readonly box?: { readonly periodUsd: number };
  readonly total: Bucket & { readonly savedUsd: number };
  readonly by: Record<"agent" | "project" | "model" | "source", Bucket[]>;
  readonly daily: Bucket[];
}

const bucket = (key: string): Bucket => ({ key, apiUsd: 0, realUsd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ms: 0, calls: 0 });

interface Agg {
  session_id: string | null;
  cwd: string | null;
  agent: string | null;
  s_agent: string | null;
  s_kind: string | null;
  s_project: string | null;
  source: string;
  billing: string;
  model: string | null;
  day: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cost_usd: number;
  ms: number;
  calls: number;
}

const agentOf = (r: Agg) => r.agent ?? r.s_agent ?? (r.s_kind === "main" ? "pai" : r.source === "terminal" ? "terminal" : r.source === "daemon" ? "threads" : r.source);
const projectOf = (r: Agg) => {
  if (r.s_project) return r.s_project;
  if (!r.cwd) return r.source;
  const name = basename(r.cwd);
  return name === "workspace" ? "pai workspace" : name;
};

/** Day in his time zone, as `YYYY-MM-DD`. */
const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: config.timezone, year: "numeric", month: "2-digit", day: "2-digit" });

async function boxMonthlyUsd(): Promise<number | undefined> {
  const box = (await hostingCost().catch(() => undefined)) as { monthlyTotal?: number; currency?: string } | undefined;
  if (!box?.monthlyTotal || !box.currency) return undefined;
  if (box.currency === "USD") return box.monthlyTotal;
  const r = await rates();
  const from = r?.rates[box.currency];
  const usd = r?.rates.USD;
  return from && usd ? (box.monthlyTotal / from) * usd : undefined;
}

export async function report(days = 30): Promise<Report> {
  const to = now();
  const from = to - days * DAY_MS;
  const rows = db
    .query(
      `SELECT sp.session_id, sp.cwd, sp.agent, s.agent AS s_agent, s.kind AS s_kind, s.project AS s_project, sp.source, sp.billing, sp.model, sp.ts,
              sp.input, sp.output, sp.cache_read, sp.cache_write, sp.cost_usd, sp.ms, (sp.input + sp.output + sp.cache_read + sp.cache_write > 0) AS calls
       FROM spend sp LEFT JOIN sessions s ON s.session_id = sp.session_id WHERE sp.ts >= ?`,
    )
    .all(from) as (Omit<Agg, "day"> & { ts: number })[];

  // The setting wins; else the login's own tier (imported late: usage.ts reaches the sessions, which reach the summaries, which record here); else the cheapest Max.
  const detected = config.claudePlanUsd ? undefined : await (await import("./usage.ts")).plan().catch(() => undefined);
  const monthly = config.claudePlanUsd ?? detected?.monthlyUsd ?? 100;
  const planPeriod = (monthly * days) / MONTH_DAYS;
  const subscriptionApi = rows.reduce((sum, r) => sum + (r.billing === "subscription" ? r.cost_usd : 0), 0);
  // Each subscription dollar at list price is worth this many real ones.
  const ratio = subscriptionApi > 0 ? planPeriod / subscriptionApi : 0;

  const total = bucket("total");
  const groups = { agent: new Map<string, Bucket>(), project: new Map<string, Bucket>(), model: new Map<string, Bucket>(), source: new Map<string, Bucket>() };
  const daily = new Map<string, Bucket>();
  const into = (b: Bucket, r: Agg, real: number) => {
    b.apiUsd += r.cost_usd;
    b.realUsd += real;
    b.input += r.input;
    b.output += r.output;
    b.cacheRead += r.cache_read;
    b.cacheWrite += r.cache_write;
    b.ms += r.ms;
    b.calls += r.calls;
  };
  const add = (map: Map<string, Bucket>, key: string, r: Agg, real: number) => {
    const b = map.get(key) ?? bucket(key);
    into(b, r, real);
    map.set(key, b);
  };
  for (const raw of rows) {
    const r = { ...raw, day: dayFmt.format(raw.ts) } as Agg;
    // Credits come with the plan, whose fee the subscription rows already carry.
    const real = r.billing === "metered" ? r.cost_usd : r.billing === "credits" ? 0 : r.cost_usd * ratio;
    into(total, r, real);
    add(groups.agent, agentOf(r), r, real);
    add(groups.project, projectOf(r), r, real);
    if (r.model) add(groups.model, r.model, r, real);
    add(groups.source, r.source, r, real);
    add(daily, r.day, r, real);
  }
  // With nothing used, the plan is still paid: the total says so even when no bucket can carry it.
  if (subscriptionApi === 0) total.realUsd += planPeriod;

  const boxMonthly = await boxMonthlyUsd();
  const sorted = (m: Map<string, Bucket>) => [...m.values()].sort((a, b) => b.apiUsd - a.apiUsd || b.ms - a.ms);
  return {
    from,
    to,
    days,
    credits: { usedUsd: rows.reduce((sum, r) => sum + (r.billing === "credits" ? r.cost_usd : 0), 0), monthlyUsd: /max/.test(detected?.tier ?? "max") ? monthly : 0 },
    plan: { monthlyUsd: monthly, periodUsd: planPeriod, tier: config.claudePlanUsd ? "set by PAI_CLAUDE_PLAN_USD" : detected?.tier },
    box: boxMonthly === undefined ? undefined : { periodUsd: (boxMonthly * days) / MONTH_DAYS },
    total: { ...total, savedUsd: total.apiUsd - total.realUsd },
    by: { agent: sorted(groups.agent), project: sorted(groups.project), model: sorted(groups.model), source: sorted(groups.source) },
    // Every day of the period, quiet ones included, so a chart's bars line up with the calendar.
    daily: Array.from({ length: days }, (_, i) => dayFmt.format(to - (days - 1 - i) * DAY_MS)).map((day) => daily.get(day) ?? bucket(day)),
  };
}
