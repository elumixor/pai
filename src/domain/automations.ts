import { bus, type PaiEvent } from "../core/bus.ts";
import { db, now } from "../core/db.ts";
import { logger } from "../core/log.ts";
import { cronMatches, minuteKey, parseCron } from "../core/time.ts";
import * as agents from "./agents.ts";
import * as asks from "./asks.ts";
import * as messages from "./messages.ts";
import * as sessions from "./sessions.ts";
import * as tasks from "./tasks.ts";
import { usage } from "./usage.ts";

const log = logger("routines");

/**
 * Routines: a trigger (an event on the bus, or a schedule in the user's time zone), an optional
 * check in code, and an action. The model only runs when the check finds something, so a
 * 15-minute inbox routine costs one API call per check, not one Claude turn.
 *
 * Actions: `notify` tells the user; `turn` gives pai a turn; `wake` gives an agent one;
 * `triage` adds the item to the next batch the small model routes (triage.ts); `task` starts a
 * thread in a project (the original action, capped). The 6-per-hour cap on task starts stays as
 * a global fuse; agents have their own turn budgets under it.
 */

export type Action = "notify" | "turn" | "task" | "wake" | "triage";

/** A check in code, run against the event before anything that costs a model turn. */
export interface Check {
  /** Any of these words must be in the payload. */
  contains?: string[];
  /** None of these may be. */
  excludes?: string[];
  /** Drop what the user muted. */
  not_muted?: boolean;
  /** A calendar event with someone from outside the user's own domains. */
  outside_attendee?: boolean;
  /** The value of this payload field must appear in one of the target agent's open tasks (a candidate's name, a thread id). */
  matches_open_task?: string;
}

export interface Automation {
  readonly id: number;
  readonly name: string;
  /** The bus event it reacts to; empty for a scheduled routine. */
  readonly event: string;
  /** Five-field cron in the user's zone; empty for an event routine. */
  readonly schedule: string;
  /** A substring the JSON payload has to contain; empty matches everything. */
  readonly filter: string;
  readonly check: Check;
  readonly action: Action;
  /** The agent `wake` wakes. */
  readonly agent: string;
  /** The project for `task`; unused otherwise. */
  readonly project: string;
  /** What is sent. `{field}` reads the payload; the whole payload follows as JSON when the template is empty. */
  readonly template: string;
  /** Who made it: `user`, `pai`, or an agent managing its own routines. */
  readonly owner: string;
  readonly enabled: boolean;
  readonly createdAt: number;
  readonly runs: number;
  readonly lastRun: number | null;
}

const MAX_TASKS_PER_HOUR = 6;
const taskStarts: number[] = [];
/** Above this share of the weekly limit, routines slow down; above the second they stop, the briefs aside. */
const SLOW_AT = 70;
const STOP_AT = 90;

const rowToAutomation = (r: Record<string, any>): Automation => ({
  id: r.id,
  name: r.name,
  event: r.event,
  schedule: r.schedule ?? "",
  filter: r.filter,
  check: r.check_rule ? (JSON.parse(r.check_rule) as Check) : {},
  action: r.action,
  agent: r.agent ?? "",
  project: r.project,
  template: r.template,
  owner: r.owner ?? "user",
  enabled: Boolean(r.enabled),
  createdAt: r.created_at,
  runs: r.runs,
  lastRun: r.last_run,
});

export const all = (): Automation[] => (db.query("SELECT * FROM automations ORDER BY id").all() as Record<string, any>[]).map(rowToAutomation);
export const get = (id: number) => all().find((a) => a.id === id);

export interface AutomationInput {
  name: string;
  event?: string;
  schedule?: string;
  filter?: string;
  check?: Check;
  action: Action;
  agent?: string;
  project?: string;
  template?: string;
  owner?: string;
  enabled?: boolean;
}

export class RoutineError extends Error {}

function validate(input: Partial<AutomationInput>, current?: Automation) {
  const event = input.event ?? current?.event ?? "";
  const schedule = input.schedule ?? current?.schedule ?? "";
  if (!event && !schedule) throw new RoutineError("a routine needs an event or a schedule");
  if (schedule) {
    try {
      parseCron(schedule);
    } catch (err) {
      throw new RoutineError((err as Error).message);
    }
  }
  const action = input.action ?? current?.action;
  const agent = input.agent ?? current?.agent ?? "";
  if (action === "wake" && (!agent || !agents.get(agent))) throw new RoutineError(`wake needs an agent that exists (${agent || "none"})`);
}

export function create(input: AutomationInput): Automation {
  validate(input);
  const res = db
    .prepare("INSERT INTO automations (name, event, schedule, filter, check_rule, action, agent, project, template, owner, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(
      input.name,
      input.event ?? "",
      input.schedule ?? "",
      input.filter ?? "",
      input.check ? JSON.stringify(input.check) : "",
      input.action,
      input.agent ?? "",
      input.project ?? "",
      input.template ?? "",
      input.owner ?? "user",
      input.enabled === false ? 0 : 1,
      now(),
    );
  return get(Number(res.lastInsertRowid))!;
}

export function update(id: number, changes: Partial<AutomationInput>): Automation | undefined {
  const current = get(id);
  if (!current) return undefined;
  validate(changes, current);
  const next = { ...current, ...Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)) } as Automation & AutomationInput;
  db.prepare("UPDATE automations SET name = ?, event = ?, schedule = ?, filter = ?, check_rule = ?, action = ?, agent = ?, project = ?, template = ?, enabled = ? WHERE id = ?").run(
    next.name,
    next.event ?? "",
    next.schedule ?? "",
    next.filter ?? "",
    next.check && Object.keys(next.check).length ? JSON.stringify(next.check) : "",
    next.action,
    next.agent ?? "",
    next.project ?? "",
    next.template ?? "",
    next.enabled === false ? 0 : 1,
    id,
  );
  return get(id);
}

export const remove = (id: number) => db.prepare("DELETE FROM automations WHERE id = ?").run(id).changes > 0;

function render(template: string, event: PaiEvent) {
  const payload = event.payload;
  if (!template.trim()) return `${event.kind}\n${JSON.stringify(payload, null, 2)}`;
  return template.replace(/\{(\w+)\}/g, (_, key: string) => (key === "kind" ? event.kind : typeof payload[key] === "object" ? JSON.stringify(payload[key]) : String(payload[key] ?? "")));
}

/** The user's own addresses' domains, from the connected mailboxes, so "outside" means someone else. */
function ownDomains(): Set<string> {
  const rows = db.query("SELECT email FROM gmail_accounts").all() as { email: string }[];
  return new Set(rows.map((r) => r.email.split("@")[1]?.toLowerCase()).filter((d): d is string => Boolean(d) && d !== "gmail.com"));
}

/** Whether the check in code lets this event through. Nothing here costs a model turn. */
export function passes(check: Check, event: PaiEvent, agent?: string): boolean {
  const text = JSON.stringify(event.payload).toLowerCase();
  if (check.contains?.length && !check.contains.some((w) => text.includes(w.toLowerCase()))) return false;
  if (check.excludes?.some((w) => text.includes(w.toLowerCase()))) return false;
  if (check.not_muted && asks.mutedBy(text, event.kind.split(".")[0])) return false;
  if (check.outside_attendee) {
    const own = ownDomains();
    const self = new Set((db.query("SELECT email FROM gmail_accounts").all() as { email: string }[]).map((r) => r.email.toLowerCase()));
    const attendees = (event.payload.attendees as string[] | undefined) ?? [];
    if (!attendees.some((a) => !self.has(a.toLowerCase()) && !own.has(a.split("@")[1]?.toLowerCase() ?? ""))) return false;
  }
  if (check.matches_open_task) {
    const value = String(event.payload[check.matches_open_task] ?? "").toLowerCase().trim();
    if (!value) return false;
    const open = tasks.list({ owner: agent || undefined });
    if (!open.some((t) => `${t.title} ${t.notes} ${t.source ?? ""} ${t.nextAction}`.toLowerCase().includes(value))) return false;
  }
  return true;
}

/** How busy the week is, as a share of the tightest weekly limit; 0 when nothing can be read. */
async function weeklyLoad(): Promise<number> {
  try {
    const u = await usage();
    return Math.max(0, ...u.windows.filter((w) => w.length > 5 * 3600).map((w) => w.percent));
  } catch {
    return 0;
  }
}

/** Runs one routine for an event. Model-spending actions are gated by the weekly load. */
async function run(rule: Automation, event: PaiEvent, opts: { scheduled?: boolean } = {}) {
  const text = render(rule.template, event);
  // A template that named only empty values (no digest tonight) has nothing to say.
  if (!text.trim()) return;
  const spends = rule.action === "turn" || rule.action === "wake" || rule.action === "task";
  if (spends && opts.scheduled) {
    const load = await weeklyLoad();
    const brief = rule.owner === "system";
    if (load >= STOP_AT && !brief) return log.info(`${rule.name}: skipped, weekly limit at ${load}%`);
    if (load >= SLOW_AT && !brief && rule.lastRun && now() - rule.lastRun < 60 * 60_000) return log.info(`${rule.name}: slowed, weekly limit at ${load}%`);
  }
  const target = rule.agent || agents.PAI;
  switch (rule.action) {
    case "notify":
      asks.notify(rule.agent || agents.PAI, text, "normal");
      break;
    case "turn":
      messages.event(agents.PAI, "routine.fired", rule.name, { meta: { routine: rule.id } });
      routineTurn(`[routine "${rule.name}"]\n${text}`);
      break;
    case "wake": {
      const a = agents.get(target);
      if (!a || a.status === "closed") throw new Error(`agent ${target} is gone`);
      messages.event(target, "routine.fired", rule.name, { meta: { routine: rule.id } });
      agents.message(target, `[routine "${rule.name}"]\n${text}`, { from: `routine:${rule.id}`, kind: "event" });
      break;
    }
    case "triage":
      triageSink(event, rule);
      break;
    case "task": {
      const recent = taskStarts.filter((t) => now() - t < 3600_000);
      taskStarts.length = 0;
      taskStarts.push(...recent);
      if (recent.length >= MAX_TASKS_PER_HOUR) throw new Error(`task cap reached (${MAX_TASKS_PER_HOUR}/h)`);
      taskStarts.push(now());
      const s = sessions.spawnTask({ title: rule.name.slice(0, 60), project: rule.project || undefined });
      s.send(text);
      break;
    }
  }
  db.prepare("UPDATE automations SET runs = runs + 1, last_run = ? WHERE id = ?").run(now(), rule.id);
  bus.emitEvent("automation.ran", { id: rule.id, name: rule.name, event: event.kind, action: rule.action });
}

/** Where pai's routine turns and triage items go; main.ts and triage.ts register them. */
let routineTurn: (text: string) => void = () => {};
let triageSink: (event: PaiEvent, rule: Automation) => void = () => {};
/** Values a scheduled routine's template can name (`{brief}`, `{digest}`), computed only when named. */
let fields: Record<string, () => string> = {};
export function link(fns: { turn?: (text: string) => void; triage?: (event: PaiEvent, rule: Automation) => void; fields?: Record<string, () => string> }) {
  if (fns.turn) routineTurn = fns.turn;
  if (fns.triage) triageSink = fns.triage;
  if (fns.fields) fields = { ...fields, ...fns.fields };
}

/** Fires every routine whose schedule matches this minute, once. */
export function tick(at = now()) {
  const key = minuteKey(at);
  for (const rule of all()) {
    if (!rule.enabled || !rule.schedule) continue;
    let due = false;
    try {
      due = cronMatches(rule.schedule, at);
    } catch {
      continue;
    }
    if (!due) continue;
    // Claimed before running, so two ticks in one minute (or a restart) cannot fire it twice.
    const claimed = db.prepare("UPDATE automations SET last_fire = ? WHERE id = ? AND last_fire != ?").run(key, rule.id, key).changes > 0;
    if (!claimed) continue;
    const named = Object.fromEntries(Object.entries(fields).filter(([k]) => rule.template.includes(`{${k}}`)).map(([k, fn]) => [k, fn()]));
    const event: PaiEvent = { kind: "schedule", payload: { routine: rule.name, at: new Date(at).toISOString(), ...named }, ts: at };
    run(rule, event, { scheduled: true }).catch((err: Error) => log.warn(`${rule.name}: ${err.message}`));
  }
}

/** Watches the bus and the clock; each matching rule runs on its own, a failing one only logs. */
export function startAutomations() {
  const handler = (event: PaiEvent) => {
    if (event.kind.startsWith("automation.") || event.kind === "session.delta" || event.kind === "message.new") return;
    for (const rule of all()) {
      if (!rule.enabled || !rule.event || rule.event !== event.kind) continue;
      if (rule.filter && !JSON.stringify(event.payload).includes(rule.filter)) continue;
      if (!passes(rule.check, event, rule.agent)) continue;
      run(rule, event).catch((err: Error) => log.warn(`${rule.name}: ${err.message}`));
    }
  };
  bus.on("event", handler);
  // On the minute, so a schedule for 08:30 fires at 08:30, not some seconds past.
  let clock: ReturnType<typeof setInterval> | undefined;
  const align = setTimeout(
    () => {
      tick();
      clock = setInterval(tick, 60_000);
    },
    60_000 - (now() % 60_000) + 500,
  );
  return () => {
    bus.off("event", handler);
    clearTimeout(align);
    clearInterval(clock);
  };
}

/** The routines pai starts with, made once: the briefs, and triage for the inbox and messages. */
export function seed() {
  const existing = all();
  const has = (name: string) => existing.some((r) => r.name === name);
  const add = (input: AutomationInput) => !has(input.name) && create(input);
  add({ name: "Morning brief", schedule: "30 8 * * *", action: "turn", agent: agents.PAI, owner: "system", template: "{brief}" });
  add({ name: "Evening digest", schedule: "30 20 * * *", action: "notify", agent: agents.PAI, owner: "system", template: "{digest}" });
  add({ name: "Inbox", event: "gmail.new", action: "triage", owner: "system", check: { not_muted: true } });
  add({ name: "Telegram messages", event: "telegram.dm", action: "triage", owner: "system", check: { not_muted: true } });
  add({ name: "Telegram groups", event: "telegram.chat", action: "triage", owner: "system", check: { not_muted: true } });
  add({ name: "LinkedIn messages", event: "linkedin.message", action: "triage", owner: "system", check: { not_muted: true } });
  add({ name: "Meeting prep", event: "calendar.upcoming", action: "triage", owner: "system", check: { outside_attendee: true } });
}
