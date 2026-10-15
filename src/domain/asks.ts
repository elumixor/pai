import { bus } from "../core/bus.ts";
import { db, now } from "../core/db.ts";
import { logger } from "../core/log.ts";
import { quiet, stamp } from "../core/time.ts";
import * as messages from "./messages.ts";
import * as tasks from "./tasks.ts";

const log = logger("asks");

/**
 * How agents reach the user: never directly. An agent hands pai an ask (a question, maybe with
 * options) or a notice (something to know) with a priority, and this decides when it reaches
 * the one chat: now with sound, now silently, held through quiet hours, saved for the next
 * brief, or only logged. Delivery is a row in the message log addressed to `user`; the clients
 * draw it from there. Also here: the user's standing pins on outbound actions, and mutes.
 */

export const PRIORITIES = ["urgent", "normal", "digest", "log"] as const;
export type Priority = (typeof PRIORITIES)[number];

/** An agent's priority shift moves its notices along this ladder; urgent stays urgent only by its own say. */
function shifted(priority: Priority, shift: number): Priority {
  if (priority === "urgent" || priority === "log" || !shift) return priority;
  const ladder: Priority[] = ["urgent", "normal", "digest", "log"];
  const i = Math.max(1, Math.min(3, ladder.indexOf(priority) - shift));
  return ladder[i]!;
}

/** How pai and its staff look up an agent's display data; agents.ts is not imported here. */
interface AgentLookup {
  priority(slug: string): number;
  breadcrumb(slug: string): string;
  /** A blocking ask parks the agent; an answer wakes it with a turn. */
  park(slug: string): void;
  deliver(slug: string, text: string, opts: { askId: number; taskId: number | null }): void;
  /** Without a turn: the answer matched the default the agent already went on with. */
  note(slug: string, text: string): void;
}
let agents: AgentLookup = { priority: () => 0, breadcrumb: (s) => s, park: () => {}, deliver: () => {}, note: () => {} };
export function link(lookup: AgentLookup) {
  agents = lookup;
}

// ---- asks ------------------------------------------------------------------

export interface Ask {
  readonly id: number;
  readonly agent: string;
  readonly question: string;
  readonly options: string[];
  readonly freeText: boolean;
  readonly priority: Priority;
  readonly blocking: boolean;
  /** What a non-blocking ask's agent goes on with meanwhile. */
  readonly fallback: string | null;
  /** Where it comes from, after the agent: "Candidate replies". */
  readonly context: string;
  readonly taskId: number | null;
  readonly status: "open" | "answered" | "dropped";
  readonly answer: string | null;
  readonly delivered: boolean;
  readonly createdAt: number;
  readonly answeredAt: number | null;
}

const toAsk = (r: Record<string, any>): Ask => ({
  id: r.id,
  agent: r.agent,
  question: r.question,
  options: JSON.parse(r.options || "[]") as string[],
  freeText: Boolean(r.free_text),
  priority: r.priority,
  blocking: Boolean(r.blocking),
  fallback: r.fallback ?? null,
  context: r.context,
  taskId: r.task_id ?? null,
  status: r.status,
  answer: r.answer ?? null,
  delivered: r.message_id !== null && r.message_id !== undefined,
  createdAt: r.created_at,
  answeredAt: r.answered_at ?? null,
});

export function getAsk(id: number): Ask | undefined {
  const row = db.query("SELECT * FROM asks WHERE id = ?").get(id) as Record<string, any> | undefined;
  return row ? toAsk(row) : undefined;
}

/** What is waiting on the user, oldest first. */
export function open(): Ask[] {
  return (db.query("SELECT * FROM asks WHERE status = 'open' ORDER BY id").all() as Record<string, any>[]).map(toAsk);
}

export function recentAsks(limit = 50): Ask[] {
  return (db.query("SELECT * FROM asks ORDER BY id DESC LIMIT ?").all(limit) as Record<string, any>[]).map(toAsk);
}

export interface AskInput {
  agent: string;
  question: string;
  options?: string[];
  freeText?: boolean;
  priority?: Priority;
  blocking?: boolean;
  fallback?: string;
  context?: string;
  taskId?: number | null;
}

export class AskError extends Error {}

const words = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);

/** Mostly the same words: the same question asked again in other phrasing. */
function similar(a: string, b: string) {
  const [x, y] = [words(a), words(b)];
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared / (x.size + y.size - shared || 1) >= 0.6;
}

/** The open ask this one would repeat: one on the same task, or the same agent's same question. */
export function pending(input: Pick<AskInput, "agent" | "question" | "taskId" | "fallback">): Ask | undefined {
  // A task's own Done / Drop card gives way to a real question about the task: it is not a repeat of it.
  const mine = input.fallback === TASK_FALLBACK;
  return open().find((a) => (mine || !isTaskAsk(a)) && ((input.taskId && a.taskId === input.taskId) || (a.agent === input.agent && similar(a.question, input.question))));
}

/** Asks the user once: a question already waiting on them is returned instead of asked again. */
export function ask(input: AskInput): Ask {
  if (!input.question?.trim()) throw new AskError("an ask needs a question");
  const already = pending(input);
  if (already) return already;
  const card = input.taskId && input.fallback !== TASK_FALLBACK ? open().find((x) => x.taskId === input.taskId && isTaskAsk(x)) : undefined;
  const blocking = input.blocking ?? true;
  if (!blocking && !input.fallback?.trim()) throw new AskError("a non-blocking ask says what the agent does meanwhile (fallback)");
  const priority = shifted(input.priority ?? "normal", agents.priority(input.agent));
  const res = db
    .prepare("INSERT INTO asks (agent, question, options, free_text, priority, blocking, fallback, context, task_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(input.agent, input.question.trim(), JSON.stringify(input.options ?? []), input.freeText === false ? 0 : 1, priority, blocking ? 1 : 0, input.fallback ?? null, input.context ?? "", input.taskId ?? null, now());
  const a = getAsk(Number(res.lastInsertRowid))!;
  if (blocking) agents.park(input.agent);
  // An ask is something the user can act on, so even a "digest" one goes out now unless it is quiet.
  if (priority === "urgent" || !quiet()) deliverAsk(a);
  const created = getAsk(a.id)!;
  bus.emitEvent("ask.created", created as unknown as Record<string, unknown>);
  if (card) drop(card.id);
  return created;
}

function deliverAsk(a: Ask) {
  const breadcrumb = [agents.breadcrumb(a.agent), a.context].filter(Boolean).join(" › ");
  const row = messages.log({
    from: a.agent,
    to: "user",
    kind: "ask",
    body: a.question,
    taskId: a.taskId,
    meta: { askId: a.id, options: a.options, breadcrumb, priority: a.priority, silent: a.priority !== "urgent", freeText: a.freeText, blocking: a.blocking, fallback: a.fallback ?? undefined, agent: a.agent },
  });
  db.prepare("UPDATE asks SET message_id = ? WHERE id = ?").run(row.id, a.id);
}

/** The user's answer, by button or by text. The agent gets it as a turn (or a note, when it changes nothing). */
export function answer(id: number, text: string, via = "user"): Ask {
  const a = getAsk(id);
  if (!a) throw new AskError(`no ask #${id}`);
  if (a.status !== "open") throw new AskError(`ask #${id} is already ${a.status}`);
  const reply = text.trim();
  if (!reply) throw new AskError("an empty answer");
  if (!a.freeText && a.options.length && !a.options.some((o) => o.toLowerCase() === reply.toLowerCase()))
    throw new AskError(`ask #${id} takes one of: ${a.options.join(", ")}`);
  db.prepare("UPDATE asks SET status = 'answered', answer = ?, answered_at = ? WHERE id = ?").run(reply, now(), id);
  messages.log({ from: "user", to: a.agent, kind: "answer", body: reply, taskId: a.taskId, meta: { askId: id, via, event: "answered", agent: a.agent } });
  const choice = reply.toLowerCase();
  if (isTaskAsk(a) && a.taskId && choice === TASK_DID.toLowerCase()) {
    // The user did their part: the work goes back to its owner, who checks it and carries on.
    tasks.update(a.taskId, { status: "active" });
    agents.deliver(a.agent, `[the user says they did what task #${a.taskId} "${tasks.get(a.taskId)?.title}" waited on: check it and carry on]`, { askId: id, taskId: a.taskId });
    const answered = getAsk(id)!;
    bus.emitEvent("ask.answered", answered as unknown as Record<string, unknown>);
    return answered;
  }
  const closing = isTaskAsk(a) && a.taskId ? ({ done: "done", drop: "dropped", [TASK_SKIP.toLowerCase()]: "dropped" } as Record<string, "done" | "dropped">)[choice] : undefined;
  if (closing) {
    // A task's card answered Done or Drop: the task closes, its owner hears it without a turn.
    tasks.update(a.taskId!, { status: closing });
    agents.note(a.agent, `[the user marked task #${a.taskId} "${tasks.get(a.taskId!)?.title}" ${closing}]`);
    const answered = getAsk(id)!;
    bus.emitEvent("ask.answered", answered as unknown as Record<string, unknown>);
    return answered;
  }
  // Answered, the decision is no longer the user's: its task goes back to whoever owns it.
  if (a.taskId && tasks.get(a.taskId)?.status === "waiting_user") tasks.update(a.taskId, { status: "active" });
  const text_ = `[answer to your question #${id}: "${a.question}"] ${reply}`;
  if (!a.blocking && a.fallback && a.fallback.trim().toLowerCase() === reply.toLowerCase()) agents.note(a.agent, text_);
  else agents.deliver(a.agent, text_, { askId: id, taskId: a.taskId });
  const answered = getAsk(id)!;
  bus.emitEvent("ask.answered", answered as unknown as Record<string, unknown>);
  return answered;
}

export function drop(id: number): boolean {
  const changed = db.prepare("UPDATE asks SET status = 'dropped', answered_at = ? WHERE id = ? AND status = 'open'").run(now(), id).changes > 0;
  if (changed) bus.emitEvent("ask.answered", getAsk(id) as unknown as Record<string, unknown>);
  return changed;
}

// ---- tasks waiting on the user ----------------------------------------------

/** What marks the Done / Drop card a waiting task gets, as against a question asked about it. */
const TASK_FALLBACK = "the task stays on the list";
const isTaskAsk = (a: Ask) => a.fallback === TASK_FALLBACK;
/** A task card's buttons: the user did their part (the owner resumes), or will not (the task drops). */
export const TASK_DID = "I did it";
export const TASK_SKIP = "Won't do";

/**
 * A task waiting on the user is a decision like any other: an ask with its own row in the chat,
 * answered I did it, Won't do or in words. Nothing waits on the user without a row to answer it on.
 * A card whose task has since been reworded (or that predates the current buttons) is asked again.
 */
export function askForTask(t: tasks.Task) {
  if (t.status !== "waiting_user") return;
  const question = t.nextAction ? `**${t.title}**\n\n${t.nextAction}` : t.title;
  const options = [TASK_DID, TASK_SKIP];
  const asked = open().filter((a) => a.taskId === t.id);
  if (asked.some((a) => !isTaskAsk(a))) return;
  const stale = asked.filter((a) => a.question !== question.trim() || a.options.join("\n") !== options.join("\n"));
  if (asked.length > stale.length) return;
  for (const a of stale) drop(a.id);
  ask({ agent: t.owner, question, options, blocking: false, fallback: TASK_FALLBACK, taskId: t.id });
}

/** Keeps a card on every waiting task: one when it starts waiting, none once it stops. Covers what waited before this ran. */
export function wireTasks() {
  for (const t of tasks.list({ status: "waiting_user" })) askForTask(t);
  const handler = (e: { kind: string; payload: Record<string, unknown> }) => {
    if (e.kind !== "task.added" && e.kind !== "task.updated") return;
    const t = tasks.get(Number(e.payload.id));
    if (!t) return;
    if (t.status === "waiting_user") askForTask(t);
    else if (e.payload.previous === "waiting_user") for (const a of open().filter((x) => x.taskId === t.id)) drop(a.id);
  };
  bus.on("event", handler);
  return () => void bus.off("event", handler);
}

/** The ask a message (by its log row id) delivered, for answering by reply. */
export function byMessage(messageId: number): Ask | undefined {
  const row = db.query("SELECT * FROM asks WHERE message_id = ?").get(messageId) as Record<string, any> | undefined;
  return row ? toAsk(row) : undefined;
}

// ---- notices ---------------------------------------------------------------

export interface Notice {
  readonly id: number;
  readonly agent: string;
  readonly text: string;
  readonly priority: Priority;
  readonly createdAt: number;
  readonly deliveredAt: number | null;
}

const toNotice = (r: Record<string, any>): Notice => ({ id: r.id, agent: r.agent, text: r.text, priority: r.priority, createdAt: r.created_at, deliveredAt: r.delivered_at ?? null });

/**
 * Something the user should know. urgent: now, with sound, even in quiet hours. normal: now,
 * silently, or when quiet hours end. digest: in the next brief. log: only in the agent's chat.
 */
export function notify(agent: string, text: string, priority: Priority = "normal"): Notice {
  if (!text.trim()) throw new AskError("an empty notice");
  if (mutedBy(text)) priority = "log";
  const p = shifted(priority, agents.priority(agent));
  const res = db.prepare("INSERT INTO notices (agent, text, priority, created_at) VALUES (?, ?, ?, ?)").run(agent, text.trim(), p, now());
  const n = toNotice(db.query("SELECT * FROM notices WHERE id = ?").get(Number(res.lastInsertRowid)) as Record<string, any>);
  if (p === "log") {
    messages.log({ from: agent, to: agent, kind: "notice", body: n.text, meta: { priority: p, agent } });
    markDelivered([n.id]);
  } else if (p === "urgent" || (p === "normal" && !quiet())) deliverNotice(n);
  return n;
}

function deliverNotice(n: Notice) {
  messages.log({ from: n.agent, to: "user", kind: "notice", body: n.text, meta: { priority: n.priority, silent: n.priority !== "urgent", breadcrumb: agents.breadcrumb(n.agent), agent: n.agent } });
  markDelivered([n.id]);
}

const markDelivered = (ids: number[]) => {
  for (const id of ids) db.prepare("UPDATE notices SET delivered_at = ? WHERE id = ?").run(now(), id);
};

/** Notices saved for the next brief. */
export function digest(): Notice[] {
  return (db.query("SELECT * FROM notices WHERE priority = 'digest' AND delivered_at IS NULL ORDER BY id").all() as Record<string, any>[]).map(toNotice);
}

/** The digest, taken: the brief that shows it marks it delivered. */
export function takeDigest(): Notice[] {
  const items = digest();
  markDelivered(items.map((n) => n.id));
  return items;
}

/** Releases what quiet hours held back. Runs every minute. */
export function flush() {
  if (quiet()) return;
  const held = (db.query("SELECT * FROM notices WHERE priority = 'normal' AND delivered_at IS NULL ORDER BY id").all() as Record<string, any>[]).map(toNotice);
  for (const n of held) deliverNotice(n);
  for (const a of open().filter((x) => !x.delivered)) deliverAsk(a);
  if (held.length) log.info(`released ${held.length} held notices`);
}

/** Open asks older than a day: the morning brief repeats them. */
export const stale = (olderThanMs = 24 * 3600 * 1000) => open().filter((a) => now() - a.createdAt > olderThanMs);

/** A plain digest line per notice, for the evening brief that needs no model. */
export function digestText(items: Notice[]) {
  return items.map((n) => `- ${agents.breadcrumb(n.agent)}: ${n.text.replace(/\s+/g, " ").slice(0, 200)} (${stamp(n.createdAt).slice(11)})`).join("\n");
}

// ---- pins: always ask / always auto, per outbound action type ---------------

export type PinMode = "ask" | "auto";

const actionKey = (action: string) => action.trim().toLowerCase().replace(/\s+/g, " ");

export function pin(action: string, mode: PinMode | null) {
  const key = actionKey(action);
  if (!key) throw new AskError("an action type, e.g. 'send email', 'calendar hold on own calendar'");
  if (mode === null) db.prepare("DELETE FROM pins WHERE action = ?").run(key);
  else db.prepare("INSERT OR REPLACE INTO pins (action, mode, created_at) VALUES (?, ?, ?)").run(key, mode, now());
  return pins();
}

export function pins(): { action: string; mode: PinMode }[] {
  return db.query("SELECT action, mode FROM pins ORDER BY action").all() as { action: string; mode: PinMode }[];
}

/** The pin for an action, matched by the action's words (a pin "send email" covers "send email to a candidate"). */
export function pinFor(action: string): PinMode | undefined {
  const key = actionKey(action);
  const hit = pins()
    .filter((p) => key === p.action || key.includes(p.action))
    .sort((a, b) => b.action.length - a.action.length)[0];
  return hit?.mode;
}

// ---- mutes: "stop telling me about newsletters" ------------------------------

export interface Mute {
  readonly id: number;
  readonly pattern: string;
  readonly source: string;
  readonly createdAt: number;
}

export function mute(pattern: string, source = ""): Mute {
  if (!pattern.trim()) throw new AskError("a mute needs words to match");
  const res = db.prepare("INSERT INTO mutes (pattern, source, created_at) VALUES (?, ?, ?)").run(pattern.trim().toLowerCase(), source, now());
  return mutes().find((m) => m.id === Number(res.lastInsertRowid))!;
}

export const unmute = (id: number) => db.prepare("DELETE FROM mutes WHERE id = ?").run(id).changes > 0;

export function mutes(): Mute[] {
  return (db.query("SELECT * FROM mutes ORDER BY id").all() as Record<string, any>[]).map((r) => ({ id: r.id, pattern: r.pattern, source: r.source, createdAt: r.created_at }));
}

/** The mute a text falls under (for one source, or any), if one does. */
export function mutedBy(text: string, source = ""): Mute | undefined {
  const t = text.toLowerCase();
  return mutes().find((m) => (!m.source || !source || m.source === source) && t.includes(m.pattern));
}
