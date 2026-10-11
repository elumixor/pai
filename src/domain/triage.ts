import { query } from "@anthropic-ai/claude-agent-sdk";
import type { PaiEvent } from "../core/bus.ts";
import { config } from "../core/config.ts";
import { db, now } from "../core/db.ts";
import { logger } from "../core/log.ts";
import * as agents from "./agents.ts";
import * as asks from "./asks.ts";
import type { Automation } from "./automations.ts";
import * as messages from "./messages.ts";
import * as tasks from "./tasks.ts";

const log = logger("triage");

/**
 * What the watchers bring in (new mail, messages, meetings coming up) is batched for five
 * minutes, then a small model routes each item: ignore it, file it under a task, wake the agent
 * that owns it, or tell the user now. Only the last two spend real quota. Muted senders and
 * subjects never reach the model.
 */

const WINDOW_MS = 5 * 60_000;
/** A batch is cut at this size so one burst cannot make an enormous prompt. */
const MAX_BATCH = 40;

export interface Item {
  readonly source: string;
  readonly kind: string;
  /** One line: who and what. */
  readonly title: string;
  readonly body: string;
  readonly link?: string;
  readonly payload: Record<string, unknown>;
  readonly at: number;
}

export type Decision =
  | { i: number; action: "ignore"; reason?: string }
  | { i: number; action: "file"; task?: number; title?: string; owner?: string; reason?: string }
  | { i: number; action: "wake"; agent: string; note?: string; task?: number; reason?: string }
  | { i: number; action: "tell"; note: string; urgent?: boolean; reason?: string };

const batch: Item[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;

/** How each watcher's event reads as an item. */
export function toItem(e: PaiEvent): Item {
  const p = e.payload as Record<string, any>;
  const source = e.kind.split(".")[0]!;
  switch (e.kind) {
    case "gmail.new":
      return { source: "mail", kind: e.kind, title: `${p.from ?? "?"} — ${p.subject ?? "(no subject)"}`, body: String(p.snippet ?? ""), link: p.link, payload: p, at: e.ts };
    case "telegram.dm":
      return { source: "telegram", kind: e.kind, title: p.out ? `you wrote to ${p.chat ?? "?"} on Telegram` : `${p.from ?? p.chat ?? "?"} on Telegram`, body: String(p.text ?? ""), link: p.link, payload: p, at: e.ts };
    case "telegram.chat":
      return { source: "telegram", kind: e.kind, title: p.out ? `you posted in ${p.chat ?? "?"}` : `${p.from ?? "?"} in ${p.chat ?? "?"}`, body: String(p.text ?? ""), link: p.link, payload: p, at: e.ts };
    case "linkedin.message":
      return { source: "linkedin", kind: e.kind, title: `${p.from ?? p.with ?? "?"} on LinkedIn`, body: String(p.text ?? ""), link: p.url, payload: p, at: e.ts };
    case "calendar.upcoming":
      return { source: "calendar", kind: e.kind, title: `${p.summary ?? "a meeting"} at ${String(p.start ?? "").slice(11, 16)}`, body: `attendees: ${(p.attendees as string[] | undefined)?.join(", ") ?? "?"}\n${p.description ?? ""}`, link: p.link, payload: p, at: e.ts };
    default:
      return { source, kind: e.kind, title: e.kind, body: JSON.stringify(p).slice(0, 1500), payload: p, at: e.ts };
  }
}

/** The routines' sink: the item waits for the rest of its burst. */
export function add(e: PaiEvent, _rule?: Automation) {
  const item = toItem(e);
  const muted = asks.mutedBy(`${item.title}\n${item.body}`, item.source);
  if (muted) return log.debug(`muted (${muted.pattern}): ${item.title}`);
  messages.event(agents.PAI, item.kind === "calendar.upcoming" ? "calendar.upcoming" : "item.arrived", item.title, { meta: { source: item.source, link: item.link } });
  batch.push(item);
  if (batch.length >= MAX_BATCH) void flush();
  else timer ??= setTimeout(() => void flush(), WINDOW_MS);
}

/** Routes what has gathered. */
export async function flush() {
  clearTimeout(timer);
  timer = undefined;
  const items = batch.splice(0, MAX_BATCH);
  if (!items.length) return;
  let decisions: Decision[];
  try {
    decisions = await decide(items);
  } catch (err) {
    // Without a decision nothing is lost: the items go to the user as one quiet notice.
    log.warn(`triage failed, passing ${items.length} items on: ${(err as Error).message}`);
    asks.notify(agents.PAI, `${items.length} new: ${items.map((i) => i.title).join("; ").slice(0, 1200)}`, "normal");
    return;
  }
  apply(items, decisions);
  if (batch.length) timer = setTimeout(() => void flush(), 1000);
}

/** What the small model is told: the items, who does what, what is open. */
export function prompt(items: Item[]) {
  const staff = agents.list().filter((a) => a.kind === "standing" || a.kind === "orchestrator");
  const open = tasks.list({ limit: 60 });
  const mutes = asks.mutes();
  return [
    "You route incoming items for a personal assistant (pai) and its agents. For each item pick one action:",
    "- ignore: newsletters, notifications, receipts, spam, anything nobody needs to act on.",
    "- file: worth keeping on the task list but nobody has to act now (give an existing task id, or a title and owner for a new one).",
    "- wake: the agent that owns this area should act on it now (give its slug and a one-line note).",
    "- tell: the user should know now (a person writing to them personally, something time-sensitive); give a one-line note; urgent only if they have minutes to act.",
    "Prefer ignore and file; wake and tell spend real effort. Never invent agents or tasks.",
    "An item that starts with \"you\" is the user's own message: he already knows and already decided. Never tell him about it — file it so the task list says what he said, and wake the agent whose open task it settles.",
    "",
    `Agents:\n${staff.map((a) => `- ${a.slug}: ${a.name} — ${a.brief.split("\n")[0]!.slice(0, 160)}`).join("\n")}`,
    `Open tasks:\n${open.map((t) => `- #${t.id} ${t.title} (owner ${t.owner})`).join("\n") || "none"}`,
    mutes.length ? `The user muted: ${mutes.map((m) => m.pattern).join(", ")}` : "",
    "",
    "Items:",
    ...items.map((it, i) => `[${i}] ${it.source} · ${it.title}\n${it.body.replace(/\s+/g, " ").slice(0, 600)}`),
  ]
    .filter((l) => l !== "")
    .join("\n");
}

const SCHEMA = {
  type: "object",
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          i: { type: "integer" },
          action: { type: "string", enum: ["ignore", "file", "wake", "tell"] },
          agent: { type: "string" },
          task: { type: "integer" },
          title: { type: "string" },
          owner: { type: "string" },
          note: { type: "string" },
          urgent: { type: "boolean" },
          reason: { type: "string" },
        },
        required: ["i", "action"],
      },
    },
  },
  required: ["decisions"],
};

/** One small-model turn, no tools, structured output. */
async function decide(items: Item[]): Promise<Decision[]> {
  const q = query({
    prompt: prompt(items),
    options: {
      model: config.models.triage,
      maxTurns: 3,
      tools: [],
      settingSources: [],
      persistSession: false,
      outputFormat: { type: "json_schema", schema: SCHEMA },
      env: Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && k !== "CLAUDE_CODE_OAUTH_TOKEN")) as Record<string, string>,
    },
  });
  for await (const m of q) {
    if (m.type !== "result") continue;
    if (m.subtype !== "success") throw new Error(m.subtype);
    const out = (m.structured_output ?? JSON.parse(m.result)) as { decisions?: Decision[] };
    return out.decisions ?? [];
  }
  throw new Error("no result");
}

/** Carries the decisions out. An item the model skipped is filed under pai's inbox, not dropped. */
export function apply(items: Item[], decisions: Decision[]) {
  const seen = new Set<number>();
  const told: string[] = [];
  for (const d of decisions) {
    const item = items[d.i];
    if (!item || seen.has(d.i)) continue;
    seen.add(d.i);
    try {
      if (d.action === "ignore") continue;
      if (d.action === "file") {
        if (d.task && tasks.get(d.task)) tasks.update(d.task, { notes: `${tasks.get(d.task)!.notes}\n${new Date(item.at).toISOString().slice(0, 10)} ${item.title}${item.link ? ` ${item.link}` : ""}`.trim() });
        else tasks.add({ title: d.title || item.title, owner: d.owner && agents.get(d.owner) ? d.owner : agents.PAI, source: item.link, notes: item.body.slice(0, 1000), createdBy: "event" });
      } else if (d.action === "wake") {
        const a = agents.get(d.agent);
        if (!a || a.status === "closed" || a.kind === "orchestrator") {
          told.push(`${item.title}${d.note ? ` — ${d.note}` : ""}`);
          continue;
        }
        agents.message(a.slug, `[new ${item.source}] ${item.title}\n${item.body.slice(0, 3000)}${item.link ? `\n${item.link}` : ""}${d.note ? `\n\ntriage: ${d.note}` : ""}`, { from: `watcher:${item.source}`, kind: "event", taskId: d.task ?? null });
      } else if (d.action === "tell") {
        if (d.urgent) asks.notify(agents.PAI, `${d.note || item.title}${item.link ? `\n${item.link}` : ""}`, "urgent");
        else told.push(`${d.note || item.title}${item.link ? ` ${item.link}` : ""}`);
      }
    } catch (err) {
      log.warn(`item ${d.i}: ${(err as Error).message}`);
    }
  }
  for (const [i, item] of items.entries()) if (!seen.has(i)) tasks.add({ title: item.title, owner: agents.PAI, source: item.link, notes: item.body.slice(0, 1000), createdBy: "event" });
  if (told.length) asks.notify(agents.PAI, told.length === 1 ? told[0]! : told.map((t) => `- ${t}`).join("\n"), "normal");
  const counts = decisions.reduce<Record<string, number>>((acc, d) => ({ ...acc, [d.action]: (acc[d.action] ?? 0) + 1 }), {});
  log.info(`${items.length} items: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")}`);
  db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('triage_last', ?)").run(JSON.stringify({ at: now(), items: items.length, ...counts }));
}
