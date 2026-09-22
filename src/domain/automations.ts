import { bus, type PaiEvent } from "../core/bus.ts";
import { db, now } from "../core/db.ts";
import { logger } from "../core/log.ts";
import * as sessions from "./sessions.ts";

const log = logger("automations");

/**
 * `on <event> -> <action>`: the rules that make modules act on each other. A rule sees
 * every event of its kind, checks an optional substring against the payload, and either
 * tells the user (Telegram), gives the main conversation a turn, or starts a task in a
 * project with the event as its first message. Tasks spend quota, so they are capped.
 */

export type Action = "notify" | "turn" | "task";

export interface Automation {
  readonly id: number;
  readonly name: string;
  readonly event: string;
  /** A substring the JSON payload has to contain; empty matches everything. */
  readonly filter: string;
  readonly action: Action;
  /** The project for `task`; unused otherwise. */
  readonly project: string;
  /** What is sent. `{field}` reads the payload; the whole payload follows as JSON when the template is empty. */
  readonly template: string;
  readonly enabled: boolean;
  readonly createdAt: number;
  readonly runs: number;
  readonly lastRun: number | null;
}

const MAX_TASKS_PER_HOUR = 6;
const taskStarts: number[] = [];

const rowToAutomation = (r: Record<string, any>): Automation => ({
  id: r.id,
  name: r.name,
  event: r.event,
  filter: r.filter,
  action: r.action,
  project: r.project,
  template: r.template,
  enabled: Boolean(r.enabled),
  createdAt: r.created_at,
  runs: r.runs,
  lastRun: r.last_run,
});

export const all = (): Automation[] => (db.query("SELECT * FROM automations ORDER BY id").all() as Record<string, any>[]).map(rowToAutomation);

export interface AutomationInput {
  name: string;
  event: string;
  filter?: string;
  action: Action;
  project?: string;
  template?: string;
  enabled?: boolean;
}

export function create(input: AutomationInput): Automation {
  const res = db
    .prepare("INSERT INTO automations (name, event, filter, action, project, template, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(input.name, input.event, input.filter ?? "", input.action, input.project ?? "", input.template ?? "", input.enabled === false ? 0 : 1, now());
  return all().find((a) => a.id === Number(res.lastInsertRowid))!;
}

export function update(id: number, changes: Partial<AutomationInput>): Automation | undefined {
  const current = all().find((a) => a.id === id);
  if (!current) return undefined;
  const next = { ...current, ...changes };
  db.prepare("UPDATE automations SET name = ?, event = ?, filter = ?, action = ?, project = ?, template = ?, enabled = ? WHERE id = ?").run(
    next.name,
    next.event,
    next.filter ?? "",
    next.action,
    next.project ?? "",
    next.template ?? "",
    next.enabled === false ? 0 : 1,
    id,
  );
  return all().find((a) => a.id === id);
}

export const remove = (id: number) => db.prepare("DELETE FROM automations WHERE id = ?").run(id).changes > 0;

function render(template: string, event: PaiEvent) {
  const payload = event.payload;
  if (!template.trim()) return `${event.kind}\n${JSON.stringify(payload, null, 2)}`;
  return template.replace(/\{(\w+)\}/g, (_, key: string) => (key === "kind" ? event.kind : String(payload[key] ?? "")));
}

async function run(rule: Automation, event: PaiEvent) {
  const text = render(rule.template, event);
  if (rule.action === "notify") bus.emitEvent("user.notify", { text });
  else if (rule.action === "turn") sessions.spawnTask({ title: rule.name.slice(0, 60) }).send(text);
  else if (rule.action === "task") {
    const recent = taskStarts.filter((t) => now() - t < 3600_000);
    taskStarts.length = 0;
    taskStarts.push(...recent);
    if (recent.length >= MAX_TASKS_PER_HOUR) throw new Error(`task cap reached (${MAX_TASKS_PER_HOUR}/h)`);
    taskStarts.push(now());
    const s = sessions.spawnTask({ title: rule.name.slice(0, 60), project: rule.project || undefined });
    s.send(text);
  }
  db.prepare("UPDATE automations SET runs = runs + 1, last_run = ? WHERE id = ?").run(now(), rule.id);
  bus.emitEvent("automation.ran", { id: rule.id, name: rule.name, event: event.kind, action: rule.action });
}

/** Watches the bus; each matching rule runs on its own, a failing one only logs. */
export function startAutomations() {
  const handler = (event: PaiEvent) => {
    if (event.kind.startsWith("automation.") || event.kind.startsWith("session.delta")) return;
    for (const rule of all()) {
      if (!rule.enabled || rule.event !== event.kind) continue;
      if (rule.filter && !JSON.stringify(event.payload).includes(rule.filter)) continue;
      run(rule, event).catch((err: Error) => log.warn(`${rule.name}: ${err.message}`));
    }
  };
  bus.on("event", handler);
  return () => bus.off("event", handler);
}
