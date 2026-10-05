import { config } from "./config.ts";

/**
 * Clock readings in the user's time zone. The box runs in UTC; schedules, quiet hours and the
 * journal's dates are the user's, so everything that reads a wall clock goes through here.
 */

export interface Zoned {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  /** 0 = Sunday, as cron counts. */
  readonly weekday: number;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function zoned(at: number = Date.now(), timeZone = config.timezone): Zoned {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(new Date(at));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    weekday: WEEKDAYS.indexOf(get("weekday")),
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `YYYY-MM-DD` in the user's zone. */
export function day(at: number = Date.now()) {
  const z = zoned(at);
  return `${z.year}-${pad(z.month)}-${pad(z.day)}`;
}

/** `YYYY-MM-DD HH:MM` in the user's zone, for text a model or a person reads. */
export function stamp(at: number = Date.now()) {
  const z = zoned(at);
  return `${day(at)} ${pad(z.hour)}:${pad(z.minute)}`;
}

/** The minute of the day a `HH:MM` names. */
function minuteOf(hhmm: string) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) throw new Error(`not a time: ${hhmm}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Whether `at` falls inside a `HH:MM-HH:MM` range, which may wrap past midnight. */
export function within(range: string, at: number = Date.now()) {
  const [from, to] = range.split("-");
  if (!from || !to) return false;
  const z = zoned(at);
  const t = z.hour * 60 + z.minute;
  const a = minuteOf(from);
  const b = minuteOf(to);
  return a <= b ? t >= a && t < b : t >= a || t < b;
}

export const quiet = (at: number = Date.now()) => within(config.quietHours, at);

/** When the current quiet hours end, as a timestamp; `at` itself when it is not quiet. */
export function quietEnds(at: number = Date.now()) {
  let t = at;
  // Minute steps over at most a day: simple, and correct across DST changes.
  for (let i = 0; i < 24 * 60 && quiet(t); i++) t += 60_000;
  return t;
}

// ---- cron ------------------------------------------------------------------

function field(spec: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText ? Number(stepText) : 1;
    let lo = min;
    let hi = max;
    if (range && range !== "*") {
      const [a, b] = range.split("-");
      lo = Number(a);
      hi = b !== undefined ? Number(b) : stepText ? max : lo;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || !Number.isInteger(step) || step < 1 || lo < min || hi > max)
      throw new Error(`bad cron field: ${spec}`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export interface Cron {
  readonly minute: Set<number>;
  readonly hour: Set<number>;
  readonly day: Set<number>;
  readonly month: Set<number>;
  readonly weekday: Set<number>;
  readonly anyDay: boolean;
  readonly anyWeekday: boolean;
}

const ALIASES: Record<string, string> = { "@hourly": "0 * * * *", "@daily": "0 0 * * *", "@weekly": "0 0 * * 0" };

/** Five fields: minute hour day-of-month month day-of-week (0 or 7 = Sunday). */
export function parseCron(expr: string): Cron {
  const fields = (ALIASES[expr.trim()] ?? expr).trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`a schedule has five fields (minute hour day month weekday): ${expr}`);
  const [mi, h, d, mo, w] = fields as [string, string, string, string, string];
  const weekday = field(w.replace(/\b7\b/g, "0"), 0, 6);
  return { minute: field(mi, 0, 59), hour: field(h, 0, 23), day: field(d, 1, 31), month: field(mo, 1, 12), weekday, anyDay: d === "*", anyWeekday: w === "*" };
}

/** Whether a schedule fires in the minute `at` falls in, read in the user's zone. */
export function cronMatches(expr: string | Cron, at: number = Date.now()) {
  const c = typeof expr === "string" ? parseCron(expr) : expr;
  const z = zoned(at);
  if (!c.minute.has(z.minute) || !c.hour.has(z.hour) || !c.month.has(z.month)) return false;
  // Cron's rule: with both day fields restricted, either one matching is enough.
  if (!c.anyDay && !c.anyWeekday) return c.day.has(z.day) || c.weekday.has(z.weekday);
  return c.day.has(z.day) && c.weekday.has(z.weekday);
}

/** The next minute a schedule fires, searched up to two weeks ahead. */
export function nextFire(expr: string, from: number = Date.now()): number | undefined {
  const c = parseCron(expr);
  let t = Math.floor(from / 60_000) * 60_000 + 60_000;
  for (let i = 0; i < 14 * 24 * 60; i++, t += 60_000) if (cronMatches(c, t)) return t;
  return undefined;
}

/** A minute key, so a schedule fires once per minute however often the clock is checked. */
export const minuteKey = (at: number = Date.now()) => new Date(Math.floor(at / 60_000) * 60_000).toISOString();
