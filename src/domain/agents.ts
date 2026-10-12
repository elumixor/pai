import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { bus, type PaiEvent } from "../core/bus.ts";
import { config } from "../core/config.ts";
import { db, kv, now } from "../core/db.ts";
import { logger } from "../core/log.ts";
import { day } from "../core/time.ts";
import { narrowed, unresolved } from "./capabilities.ts";
import { get as getProject } from "./catalog.ts";
import * as journal from "./journal.ts";
import * as messages from "./messages.ts";
import { agentInstructions, instructionsFor } from "./prompts.ts";
import type { AgentSetup, Effort, Session } from "./session.ts";
import * as sessions from "./sessions.ts";

const log = logger("agents");

/**
 * pai and its staff. An agent is a folder plus a row: the folder (`workspace/agents/<slug>/`)
 * holds who it is (CLAUDE.md) and where things stand (STATE.md), the row where it is in its
 * life. Its conversation is a Claude Code session that can be thrown away and rebuilt from the
 * folder at any time: one idle for more than a day starts fresh from those two files.
 *
 * - `orchestrator`: pai, the one voice the user hears (main.ts holds its session).
 * - `standing`: owns an area of the user's life (hiring, the job search); only pai creates one.
 * - `sub`: one bounded job for its parent; reports once and closes.
 * - `service`: owns no tasks, answers requests (Voice rewrites drafts in the user's voice).
 */

export type AgentKind = "orchestrator" | "standing" | "sub" | "service";
export type AgentStatus = "idle" | "queued" | "working" | "waiting" | "closed";

export interface Budget {
  /** Turns a day before pai is told and the agent stops being woken. */
  readonly turnsPerDay: number;
  /** Wall time one turn may take before it is interrupted. */
  readonly turnMinutes: number;
}

export const DEFAULT_BUDGET: Budget = { turnsPerDay: 40, turnMinutes: 20 };
const SUB_BUDGET: Budget = { turnsPerDay: 15, turnMinutes: 20 };

export interface Agent {
  readonly slug: string;
  readonly name: string;
  readonly kind: AgentKind;
  readonly parent: string | null;
  readonly brief: string;
  readonly folder: string;
  readonly project: string | null;
  readonly tools: string[] | null;
  readonly model: string | null;
  readonly effort: Effort | null;
  readonly budget: Budget;
  readonly priority: number;
  readonly status: AgentStatus;
  readonly sessionId: string | null;
  readonly threadId: number | null;
  readonly cardId: number | null;
  readonly turnsToday: number;
  readonly costUsd: number;
  readonly createdAt: number;
  readonly lastActive: number;
  readonly closedAt: number | null;
}

export const PAI = "pai";
/** pai, a standing agent, a sub-agent: deeper work is a to-do inside a sub-agent, not another layer. */
export const MAX_DEPTH = 3;
/** An agent idle this long starts fresh from its folder instead of resuming a long transcript. */
const FRESH_AFTER_MS = 24 * 3600 * 1000;
const REPORT_CHARS = 1500;

const toAgent = (r: Record<string, any>): Agent => ({
  slug: r.slug,
  name: r.name,
  kind: r.kind,
  parent: r.parent ?? null,
  brief: r.brief,
  folder: r.folder,
  project: r.project ?? null,
  tools: r.tools ? (JSON.parse(r.tools) as string[]) : null,
  model: r.model ?? null,
  effort: r.effort ?? null,
  budget: { ...DEFAULT_BUDGET, ...(JSON.parse(r.budget || "{}") as Partial<Budget>) },
  priority: r.priority ?? 0,
  status: r.status,
  sessionId: r.session_id ?? null,
  threadId: r.thread_id ?? null,
  cardId: r.card_id ?? null,
  turnsToday: r.turns_day === day() ? r.turns_today : 0,
  costUsd: r.cost_usd,
  createdAt: r.created_at,
  lastActive: r.last_active,
  closedAt: r.closed_at ?? null,
});

export class AgentError extends Error {}

export function get(slug: string): Agent | undefined {
  const row = db.query("SELECT * FROM agents WHERE slug = ?").get(slug) as Record<string, any> | undefined;
  return row ? toAgent(row) : undefined;
}

export function list(opts: { closed?: boolean; parent?: string } = {}): Agent[] {
  const rows = db.query("SELECT * FROM agents ORDER BY created_at").all() as Record<string, any>[];
  return rows.map(toAgent).filter((a) => (opts.closed || a.status !== "closed") && (opts.parent === undefined || a.parent === opts.parent));
}

export function byThread(threadId: number): Agent | undefined {
  const row = db.query("SELECT * FROM agents WHERE thread_id = ? AND status != 'closed' AND kind != 'sub' ORDER BY created_at DESC LIMIT 1").get(threadId) as Record<string, any> | undefined;
  return row ? toAgent(row) : undefined;
}

/** The agent a session works for. */
export function bySession(sessionId: string): Agent | undefined {
  const row = db.query("SELECT * FROM agents WHERE session_id = ?").get(sessionId) as Record<string, any> | undefined;
  return row ? toAgent(row) : undefined;
}

/** pai is depth 1, its standing agents 2, their sub-agents 3. */
export function depth(slug: string): number {
  let d = 0;
  for (let a = get(slug); a; a = a.parent ? get(a.parent) : undefined) d += 1;
  return d;
}

/** The chain from pai down to an agent, for a breadcrumb: `pai › Hiring › Screener`. */
export function lineage(slug: string): Agent[] {
  const chain: Agent[] = [];
  for (let a = get(slug); a; a = a.parent ? get(a.parent) : undefined) chain.unshift(a);
  return chain;
}

export const breadcrumb = (slug: string) => lineage(slug).map((a) => a.name).join(" › ");

function set(slug: string, fields: Record<string, string | number | null>) {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE agents SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE slug = ?`).run(...keys.map((k) => fields[k] ?? null), slug);
  const agent = get(slug);
  if (agent) bus.emitEvent("agent.changed", agent as unknown as Record<string, unknown>);
  return agent;
}

export const setThread = (slug: string, threadId: number | null) => set(slug, { thread_id: threadId });
/** pai's session changed (main.ts started a fresh one). */
export const adoptSession = (sessionId: string) => set(PAI, { session_id: sessionId, last_active: now() });
export const setCard = (slug: string, cardId: number | null) => set(slug, { card_id: cardId });
const setStatus = (slug: string, status: AgentStatus) => set(slug, { status, last_active: now() });

// ---- creation --------------------------------------------------------------

const slugify = (name: string) =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "agent";

function freeSlug(name: string) {
  const base = slugify(name);
  if (base === PAI) return `${base}-agent`;
  let slug = base;
  for (let i = 2; get(slug); i++) slug = `${base}-${i}`;
  return slug;
}

export interface CreateInput {
  name: string;
  kind: Exclude<AgentKind, "orchestrator">;
  /** Who it reports to; pai for standing and service agents. */
  parent?: string;
  /** Goal, voice, rules, what "done" means: becomes its CLAUDE.md. */
  brief: string;
  /** MCP servers it may use, by name or part of one (gmail, linkedin, notion, calendar, browser…); omitted = its parent's. */
  tools?: string[] | null;
  model?: string | null;
  effort?: Effort | null;
  budget?: Partial<Budget>;
  /** A repo it works in: a coding agent, whose sessions run there. */
  project?: string | null;
  /** The first job, sent as soon as it exists. */
  task?: string;
  taskId?: number | null;
}

/** The orchestrator's row, made on first start. Its session lives in main.ts. */
export function ensurePai(): Agent {
  const existing = get(PAI);
  if (existing) return existing;
  db.prepare(
    "INSERT INTO agents (slug, name, kind, parent, brief, folder, status, created_at, last_active, budget) VALUES (?, 'pai', 'orchestrator', NULL, ?, ?, 'idle', ?, ?, '{}')",
  ).run(PAI, "The orchestrator: the one voice the user hears.", config.workspace, now(), now());
  return get(PAI)!;
}

export function create(input: CreateInput, by: string = PAI): Agent {
  ensurePai();
  const parentSlug = input.kind === "sub" ? (input.parent ?? by) : PAI;
  const parent = get(parentSlug);
  if (!parent || parent.status === "closed") throw new AgentError(`no agent ${parentSlug} to report to`);
  if (input.kind !== "sub" && by !== PAI) throw new AgentError("only pai creates standing and service agents; start a sub-agent instead");
  if (input.kind === "sub" && by !== PAI && by !== parentSlug) throw new AgentError("an agent starts sub-agents only under itself");
  if (depth(parentSlug) + 1 > MAX_DEPTH) throw new AgentError(`depth is capped at ${MAX_DEPTH}: ${parent.name} cannot start sub-agents; make it a to-do in its own work`);
  if (!input.name?.trim()) throw new AgentError("an agent needs a name");
  if (!input.brief?.trim()) throw new AgentError("an agent needs a brief: goal, context, what done means");
  if (input.project && !getProject(input.project)) throw new AgentError(`no project ${input.project}`);

  // A sub-agent gets at most its parent's tools, never more.
  let tools = input.tools === undefined ? parent.tools : input.tools;
  if (parent.tools && tools) tools = narrowed(tools, parent.tools);
  else if (parent.tools && !tools) tools = parent.tools;

  const slug = freeSlug(input.name);
  const folder = input.kind === "sub" && parent.kind !== "orchestrator" ? join(parent.folder, "sub", slug) : join(config.workspace, "agents", slug);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "CLAUDE.md"), roleFile(input.name, input.brief));
  if (!existsSync(join(folder, "STATE.md"))) writeFileSync(join(folder, "STATE.md"), `# State\n\nNothing yet: ${input.name} was just created (${day()}).\n`);

  const budget = { ...(input.kind === "sub" ? SUB_BUDGET : DEFAULT_BUDGET), ...input.budget };
  db.prepare(
    `INSERT INTO agents (slug, name, kind, parent, brief, folder, project, tools, model, effort, budget, status, created_at, last_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?)`,
  ).run(slug, input.name.trim(), input.kind, parentSlug, input.brief.trim(), folder, input.project ?? null, tools ? JSON.stringify(tools) : null, input.model ?? null, input.effort ?? null, JSON.stringify(budget), now(), now());
  const agent = get(slug)!;
  log.info(`created ${agent.kind} ${slug} under ${parentSlug}`);
  warnUnresolved(agent);
  messages.event(slug, input.kind === "sub" ? "agent.spawned" : "agent.created", `${parent.name} ${input.kind === "sub" ? "started" : "created"} ${agent.name}`, { from: parentSlug, to: parentSlug });
  bus.emitEvent("agent.created", agent as unknown as Record<string, unknown>);
  if (input.task?.trim()) message(slug, input.task, { from: parentSlug, kind: "delegate", taskId: input.taskId });
  return agent;
}

/**
 * A capability that matches no MCP server would otherwise be found out by the agent mid-task,
 * searching for tools it was promised. It is said once here, and carried on the agent's row
 * (`unresolvedTools`) for `pai agents` and for its own instructions.
 */
function warnUnresolved(a: Agent) {
  const missing = unresolved(a.tools);
  if (!missing.length) return;
  const what = missing.join(", ");
  log.warn(`${a.slug}: no MCP server matches ${what}; it will have no such tools`);
  messages.event(a.slug, "agent.tools_missing", `${a.name} declares tools no server provides: ${what}`, { from: a.parent ?? PAI, to: a.parent ?? PAI });
}

/** An agent's CLAUDE.md: who it is, with its STATE.md pulled in, so a fresh session starts knowing both. */
function roleFile(name: string, brief: string) {
  return `# ${name}\n\n${brief.trim()}\n\n## Where things stand\n\n@STATE.md\n`;
}

/** Changes what an agent runs with; its session restarts on the next message. */
export function configure(slug: string, changes: { brief?: string; tools?: string[] | null; model?: string | null; effort?: Effort | null; budget?: Partial<Budget>; priority?: number; name?: string; parent?: string }) {
  const a = get(slug);
  if (!a || a.kind === "orchestrator") throw new AgentError(`no agent ${slug}`);
  const fields: Record<string, string | number | null> = {};
  if (changes.name) fields.name = changes.name;
  if (changes.parent) {
    // Moving an agent under another: the new parent must exist, be open, and not sit below this one.
    const parent = get(changes.parent);
    if (!parent || parent.status === "closed") throw new AgentError(`no parent ${changes.parent}`);
    if (parent.slug === slug || lineage(parent.slug).some((p) => p.slug === slug)) throw new AgentError(`${changes.parent} is under ${slug}`);
    fields.parent = parent.slug;
  }
  if (changes.brief) {
    fields.brief = changes.brief;
    writeFileSync(join(a.folder, "CLAUDE.md"), roleFile(changes.name ?? a.name, changes.brief));
  }
  if (changes.tools !== undefined) fields.tools = changes.tools ? JSON.stringify(changes.tools) : null;
  if (changes.model !== undefined) fields.model = changes.model;
  if (changes.effort !== undefined) fields.effort = changes.effort;
  if (changes.budget) fields.budget = JSON.stringify({ ...a.budget, ...changes.budget });
  if (changes.priority !== undefined) fields.priority = Math.max(-2, Math.min(2, Math.round(changes.priority)));
  const updated = set(slug, fields);
  if (changes.tools !== undefined && updated) warnUnresolved(updated);
  // Tools and model are fixed when a process starts; the next message starts one with these.
  if (changes.tools !== undefined || changes.model !== undefined || changes.effort !== undefined || changes.brief) sessionOf(a)?.kill();
  return updated!;
}

// ---- sessions --------------------------------------------------------------

/** What a session of this agent is built with: its role in the system prompt, its tools. */
export function setupOf(a: Agent): AgentSetup {
  const cwd = workdir(a);
  // In its own folder Claude Code reads its CLAUDE.md by itself; in a repo it has to be told.
  const own = cwd === a.folder ? "" : readIf(join(a.folder, "CLAUDE.md")).replace("@STATE.md", readIf(join(a.folder, "STATE.md")));
  return {
    slug: a.slug,
    // What it does not have is one generated paragraph in prompts.ts, for every session kind.
    instructions: agentInstructions(a, own),
    tools: a.tools ?? undefined,
    additionalDirectories: cwd === a.folder ? [] : [a.folder],
  };
}


/** What an agent is told, as the client shows it: its own files (CLAUDE.md and what it imports) and the instructions appended to Claude Code's. */
export function instructionsOf(a: Agent) {
  const own = readIf(join(a.folder, "CLAUDE.md"));
  const imports = [...own.matchAll(/^@(\S+\.md)\s*$/gm)].map((m) => m[1]!);
  const files = [{ name: "CLAUDE.md", text: own }, ...imports.map((name) => ({ name, text: readIf(join(a.folder, name)) }))].filter((f) => f.text.trim());
  return { folder: a.folder, files, system: instructionsFor(isCoding(a) ? "code" : "chat", a.project ?? undefined, setupOf(a)) };
}

const readIf = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");
const workdir = (a: Agent) => (a.project ? (getProject(a.project)?.path ?? a.folder) : a.folder);
const isCoding = (a: Agent) => Boolean(a.project && getProject(a.project)?.kind === "repo");

function sessionOf(a: Agent): Session | undefined {
  return a.sessionId ? sessions.find(a.sessionId) : undefined;
}

/** The forum topic an agent's session posts into: its own, or (a sub-agent) its parent's. */
function topicOf(a: Agent): number | null {
  if (a.threadId !== null) return a.threadId;
  const parent = a.parent ? get(a.parent) : undefined;
  return parent && parent.kind !== "orchestrator" ? topicOf(parent) : null;
}

/**
 * A live session for the agent: resumed from its transcript when it worked within the last day,
 * otherwise started fresh from CLAUDE.md + STATE.md — which is what keeps its context small.
 */
function ensureSession(a: Agent): Session {
  const recent = a.sessionId && now() - a.lastActive < FRESH_AFTER_MS;
  if (recent) {
    const s = sessions.ensureLive(a.sessionId!);
    if (s) {
      if (s.threadId === null && topicOf(a) !== null) {
        s.threadId = topicOf(a);
        s.persist();
      }
      return s;
    }
  }
  sessionOf(a)?.kill();
  const s = sessions.spawnTask({
    title: a.name,
    project: a.project ?? undefined,
    cwd: workdir(a),
    threadId: topicOf(a),
    model: a.model,
    effort: a.effort,
    agent: setupOf(a),
  });
  set(a.slug, { session_id: s.id });
  return s;
}

// ---- waking ----------------------------------------------------------------

interface Pending {
  slug: string;
  text: string;
  requestId?: number;
  taskId?: number | null;
}

const QUEUE_KEY = "agent_queue";
const queue: Pending[] = (() => {
  try {
    return JSON.parse(kv.get(QUEUE_KEY) ?? "[]") as Pending[];
  } catch {
    return [];
  }
})();
const saveQueue = () => kv.set(QUEUE_KEY, JSON.stringify(queue));

/**
 * The turns each agent has been sent and not finished, oldest first, with the request a turn
 * answers (0 for none) and the task it is about: a session queues turns, so the head is the one
 * whose end comes next. The task's thread gets the turn's report.
 */
const answering = new Map<string, { requestId: number; taskId: number | null }[]>();
const turnTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** What each process had cost at its last turn end; the SDK reports a running total. */
const booked = new Map<string, number>();
/** Parents that asked to hear back with a turn rather than a note. */

function load() {
  return list().filter((a) => a.kind !== "orchestrator" && a.status === "working").reduce((n, a) => n + (isCoding(a) ? 2 : 1), 0);
}

export interface MessageOptions {
  from: string;
  kind?: messages.MessageKind;
  taskId?: number | null;
  requestId?: number;
  meta?: messages.MessageMeta;
  /** The caller logged this hop already. */
  logged?: boolean;
}

/**
 * Something said to an agent: logged, then handed to its session as a turn. When too many are
 * working the turn queues; a spent budget refuses it and tells pai.
 */
export function message(slug: string, text: string, opts: MessageOptions): messages.Message | undefined {
  const a = get(slug);
  if (!a) throw new AgentError(`no agent ${slug}`);
  if (a.status === "closed") throw new AgentError(`${a.name} is closed`);
  if (a.kind === "orchestrator") throw new AgentError("pai is reached through main.ts");
  const row = opts.logged ? undefined : messages.log({ from: opts.from, to: slug, kind: opts.kind ?? "chat", body: text, taskId: opts.taskId, meta: { ...opts.meta, requestId: opts.requestId } });
  const prefix = opts.from === "user" ? "[the user, writing to you directly]" : opts.from === PAI ? "[pai]" : `[${get(opts.from)?.name ?? opts.from}]`;
  wake(slug, `${prefix} ${text}${opts.taskId ? `\n\n(task #${opts.taskId})` : ""}`, opts.requestId, opts.taskId);
  return row;
}

function wake(slug: string, text: string, requestId?: number, taskId?: number | null) {
  const a = get(slug)!;
  if (a.turnsToday >= a.budget.turnsPerDay) {
    messages.event(slug, "error", `${a.name} hit its budget of ${a.budget.turnsPerDay} turns today; not woken`, { to: a.parent ?? PAI });
    tellParent(a, `${a.name} hit its budget (${a.budget.turnsPerDay} turns a day) and was not woken. Raise it with configure_agent if the work should go on.`);
    return;
  }
  const s = a.sessionId ? sessions.find(a.sessionId) : undefined;
  // A session mid-turn queues the message itself; capacity only matters for waking an idle agent.
  const alreadyWorking = a.status === "working" && s && s.state === "busy";
  const weight = isCoding(a) ? 2 : 1;
  if (!alreadyWorking && load() + weight > config.maxWorkingAgents) {
    queue.push({ slug, text, requestId, taskId });
    saveQueue();
    setStatus(slug, "queued");
    log.info(`${slug} queued (${load()} working)`);
    return;
  }
  run(a, text, requestId, taskId);
}

function run(a: Agent, text: string, requestId?: number, taskId?: number | null) {
  const s = ensureSession(a);
  answering.set(a.slug, [...(answering.get(a.slug) ?? []), { requestId: requestId ?? 0, taskId: taskId ?? null }]);
  const today = day();
  db.prepare("UPDATE agents SET turns_today = CASE WHEN turns_day = ? THEN turns_today + 1 ELSE 1 END, turns_day = ? WHERE slug = ?").run(today, today, a.slug);
  setStatus(a.slug, "working");
  s.send(text, { origin: "system" });
  clearTimeout(turnTimers.get(a.slug));
  turnTimers.set(
    a.slug,
    setTimeout(() => {
      if (s.state !== "busy") return;
      void s.interrupt();
      messages.event(a.slug, "error", `${a.name}'s turn ran past ${a.budget.turnMinutes} minutes and was stopped`, { to: a.parent ?? PAI });
      tellParent(a, `${a.name}'s turn ran past its ${a.budget.turnMinutes}-minute budget and was interrupted.`);
    }, a.budget.turnMinutes * 60_000),
  );
}

/** Whoever is next in line, once someone stops working. */
function drain() {
  while (queue.length) {
    const next = queue[0]!;
    const a = get(next.slug);
    if (!a || a.status === "closed") {
      queue.shift();
      continue;
    }
    if (load() + (isCoding(a) ? 2 : 1) > config.maxWorkingAgents) break;
    queue.shift();
    saveQueue();
    run(a, next.text, next.requestId, next.taskId);
  }
  saveQueue();
}

/** A turn for an agent whose message is already in the log (an answer to its ask). */
export function deliver(slug: string, text: string, opts: { taskId?: number | null } = {}) {
  const a = get(slug);
  if (!a || a.status === "closed") return;
  if (a.status === "waiting") setStatus(slug, "idle");
  wake(slug, `${text}${opts.taskId ? `\n\n(task #${opts.taskId})` : ""}`, undefined, opts.taskId);
}

/** Context for an agent's next turn without one now; an agent with no live process gets a turn instead. */
export function noteTo(slug: string, text: string) {
  const a = get(slug);
  if (!a || a.status === "closed") return;
  const s = sessionOf(a);
  if (s && s.state !== "dead") s.inject(text);
  else wake(slug, text);
}

/** The user wrote in an agent's own chat: that is a message to the agent, and pai gets a line about it. */
export function fromUser(slug: string, text: string, taskId?: number | null) {
  const a = get(slug);
  if (!a) throw new AgentError(`no agent ${slug}`);
  const row = message(slug, text, { from: "user", kind: "chat", taskId });
  notePai(`[the user stepped into ${breadcrumb(slug)}'s chat] ${text.replace(/\s+/g, " ").slice(0, 200)}`);
  return row;
}

// ---- reports ---------------------------------------------------------------

/** How a report reaches pai: main.ts registers these, so this file does not import it. */
interface PaiLink {
  note(text: string): void;
  turn(text: string): void;
}
let paiLink: PaiLink = { note: () => {}, turn: () => {} };
export function linkPai(link: PaiLink) {
  paiLink = link;
}
const notePai = (text: string) => paiLink.note(text);

/**
 * What pai's staff hand back to it — reports, failures, spent budgets — is pai's to act on, never left for
 * the user to pick up. A burst of them becomes one turn once things settle for a moment.
 */
const REPORT_BATCH_MS = 15_000;
let forPai: string[] = [];
let forPaiTimer: ReturnType<typeof setTimeout> | undefined;
function toPai(text: string) {
  forPai.push(text);
  clearTimeout(forPaiTimer);
  forPaiTimer = setTimeout(flushReports, REPORT_BATCH_MS);
}

/** Hands pai what has gathered now (tests call it rather than wait). */
export function flushReports() {
  clearTimeout(forPaiTimer);
  if (!forPai.length) return;
  const batch = forPai;
  forPai = [];
  paiLink.turn(
      `${batch.join("\n\n")}\n\n[Handle this yourself: the next step to an agent (message_agent), the task list, or closing what is done. Only a choice that is the user's goes to them, as an ask_user (blocking false) with one-tap options; what they must do themselves is a task with status waiting_user. If nothing is for the user, end with no text.]`,
  );
}

/** How a finished turn's text answers a request: requests.ts registers it. */
let onAnswered: (requestId: number, by: string, text: string) => void = () => {};
export function onRequestAnswered(fn: typeof onAnswered) {
  onAnswered = fn;
}

function tellParent(a: Agent, text: string) {
  if (!a.parent || a.parent === PAI) return toPai(`[${a.name}] ${text}`);
  const p = get(a.parent);
  if (p && p.status !== "closed") sessionOf(p)?.inject(`[${a.name}] ${text}`);
}

/** An agent marks itself waiting on the user (a blocking ask); its next turn end is not a report. */
export function park(slug: string) {
  setStatus(slug, "waiting");
}

function turnEnded(a: Agent, payload: Record<string, unknown>) {
  clearTimeout(turnTimers.get(a.slug));
  const text = String(payload.text ?? "").trim();
  const cost = Number(payload.costUsd ?? 0);
  const current = get(a.slug)!;
  const s = sessionOf(current);
  // The SDK's cost is the running total of the process, so only what this turn added is booked.
  const key = s?.id ?? a.slug;
  const before = booked.get(key) ?? 0;
  booked.set(key, cost);
  db.prepare("UPDATE agents SET cost_usd = cost_usd + ? WHERE slug = ?").run(Math.max(0, cost - before), a.slug);

  // A turn that answered a request has its text as the response.
  const pending = answering.get(a.slug) ?? [];
  const { requestId, taskId } = pending.shift() ?? { requestId: 0, taskId: null };
  if (requestId) onAnswered(requestId, a.slug, text);
  const ids = requestId ? [requestId] : [];

  const waiting = current.status === "waiting";
  if (!waiting) setStatus(a.slug, pending.length ? "working" : "idle");
  checkState(current);

  // A parked agent's "asked, waiting" is not a report; its answer brings the next turn.
  if (text && !ids.length && !waiting) {
    let report = String(payload.final ?? text).trim().slice(0, REPORT_CHARS);
    // A sub-agent does one job: once it has said what came of it, it closes. Closing archives its folder, so
    // the files its report points at are named where they are now.
    if (current.kind === "sub") {
      const closed = close(a.slug, report.split("\n")[0]!.slice(0, 200));
      if (closed.folder !== a.folder) report = report.replaceAll(a.folder, closed.folder);
    }
    messages.log({ from: a.slug, to: a.parent ?? PAI, kind: "report", body: report, taskId, meta: { agent: a.slug } });
    if (a.parent === PAI || !a.parent) {
      toPai(`[${a.name} reported]\n${report}`);
    } else {
      const parent = get(a.parent);
      if (parent && parent.status !== "closed") message(parent.slug, `${a.name} reported:\n${report}`, { from: a.slug, kind: "report", taskId, meta: { agent: a.slug } });
    }
  }
  drain();
}

function turnFailed(a: Agent, message: string) {
  clearTimeout(turnTimers.get(a.slug));
  answering.get(a.slug)?.shift();
  setStatus(a.slug, "idle");
  messages.event(a.slug, "error", `${a.name} failed: ${message}`, { to: a.parent ?? PAI });
  tellParent(a, `failed: ${message}`);
  drain();
}

/** STATE.md is what makes a fresh start safe; an agent that did not rewrite it is reminded on its next turn. */
function checkState(a: Agent) {
  const file = join(a.folder, "STATE.md");
  const changed = existsSync(file) ? statSync(file).mtimeMs : 0;
  if (changed < a.lastActive - 1000 && a.kind !== "service")
    sessionOf(a)?.inject("Reminder: rewrite STATE.md at the end of every turn (where things stand, who said what, next steps). It is what you start from tomorrow.");
}

/** Follows agent sessions' turns on the bus. */
export function start() {
  ensurePai();
  // Revived sessions find their agent's role and tools through this; registered here, not at import, because the modules import each other.
  sessions.resolveAgentsWith((slug) => {
    const a = get(slug);
    return a ? setupOf(a) : undefined;
  });
  // Agents that were mid-turn when the daemon stopped are resumed by sessions.resumeInterrupted; the rest are idle.
  for (const a of list()) if (a.kind !== "orchestrator" && (a.status === "working" || a.status === "queued") && !queue.some((q) => q.slug === a.slug)) setStatus(a.slug, "idle");
  const handler = (e: PaiEvent) => {
    if (e.kind === "session.input" && e.sessionId && e.sessionId === get(PAI)?.sessionId) return void setStatus(PAI, "working");
    if (!e.sessionId || !(e.kind === "session.turn_end" || e.kind === "session.error" || e.kind === "session.exit")) return;
    const a = bySession(e.sessionId);
    if (!a || a.status === "closed") return;
    // pai's own status is only for the tree; its turns are main.ts's business.
    if (a.kind === "orchestrator") return void setStatus(PAI, "idle");
    if (e.kind === "session.turn_end") turnEnded(a, e.payload);
    else if (e.kind === "session.error") turnFailed(a, String(e.payload.message ?? "error"));
    else if (a.status === "working") {
      setStatus(a.slug, "idle");
      drain();
    }
  };
  bus.on("event", handler);
  setTimeout(drain, 5_000);
  return () => bus.off("event", handler);
}

// ---- stopping --------------------------------------------------------------

/**
 * The user stopped an agent: its running turn is interrupted and its waiting turns dropped, and its
 * sub-agents stop with it. It stays open — the next message wakes it as usual. The slugs that stopped.
 */
export async function stop(slug: string): Promise<string[]> {
  const a = get(slug);
  if (!a || a.kind === "orchestrator") throw new AgentError(`no agent ${slug}`);
  const stopped: string[] = [];
  const targets = [a];
  for (let i = 0; i < targets.length; i++) targets.push(...list({ parent: targets[i]!.slug }));
  for (const target of targets) {
    if (target.status === "closed") continue;
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i]!.slug === target.slug) queue.splice(i, 1);
    clearTimeout(turnTimers.get(target.slug));
    const s = sessionOf(target);
    const busy = s?.state === "busy";
    if (busy) await s!.interrupt();
    if (busy || target.status === "working" || target.status === "queued") {
      if (target.status === "queued" || !busy) setStatus(target.slug, "idle");
      stopped.push(target.slug);
    }
  }
  saveQueue();
  if (stopped.length) {
    messages.event(slug, "stopped", `${a.name} stopped by the user`, { to: a.parent ?? PAI });
    notePai(`[the user stopped ${breadcrumb(slug)}${stopped.length > 1 ? ` and ${stopped.length - 1} below it` : ""}]`);
  }
  drain();
  return stopped;
}

// ---- closing ---------------------------------------------------------------

/** Done: the session goes, the folder is archived, a line goes into the journal. Its sub-agents close with it. */
export function close(slug: string, summary = ""): Agent {
  const a = get(slug);
  if (!a || a.kind === "orchestrator") throw new AgentError(`no agent ${slug}`);
  if (a.status === "closed") return a;
  for (const child of list({ parent: slug })) close(child.slug, `closed with ${a.name}`);
  clearTimeout(turnTimers.get(slug));
  const s = sessionOf(a);
  if (s && s.state !== "busy") s.kill();
  let folder = a.folder;
  if (existsSync(a.folder)) {
    folder = join(config.workspace, "agents", ".archive", `${slug}-${day()}`);
    mkdirSync(dirname(folder), { recursive: true });
    try {
      renameSync(a.folder, folder);
    } catch (err) {
      log.warn(`${slug}: folder not archived: ${(err as Error).message}`);
      folder = a.folder;
    }
  }
  const index = queue.findIndex((q) => q.slug === slug);
  if (index >= 0) {
    queue.splice(index, 1);
    saveQueue();
  }
  // Routines that would wake it, or that it kept for itself, go with it.
  db.prepare("DELETE FROM automations WHERE agent = ? OR owner = ?").run(slug, slug);
  const closed = set(slug, { status: "closed", closed_at: now(), folder })!;
  journal.append(`${a.name} (${a.kind}) closed${summary ? `: ${summary}` : ""}`);
  messages.event(slug, "agent.closed", `${a.name} closed${summary ? `: ${summary}` : ""}`, { to: a.parent ?? PAI });
  return closed;
}

/** Status, open work and spend per agent, for the tree view. */
/** A plain thread an agent started (or, with no agent behind it, one of pai's: terminal, a chat). */
export interface AgentThread {
  readonly sessionId: string;
  readonly shortId: string;
  readonly title: string;
  readonly project: string | null;
  readonly state: string;
  readonly threadId: number | null;
  readonly lastActivity: number;
  readonly costUsd: number;
}

const THREADS_SHOWN_FOR_MS = 7 * 86_400_000;

/** Each agent's threads, by who started them: the session a thread's parent is belongs to an agent, or else to pai. */
function threadsByAgent(): Map<string, AgentThread[]> {
  const rows = sessions.recent(80);
  const ownerOf = new Map(list().filter((a) => a.sessionId).map((a) => [a.sessionId!, a.slug]));
  for (const r of rows) if (r.agent) ownerOf.set(r.sessionId, r.agent);
  const out = new Map<string, AgentThread[]>();
  for (const r of rows) {
    if (r.agent) continue;
    const live = r.state === "busy" || r.state === "starting";
    if (!live && now() - r.lastActivity > THREADS_SHOWN_FOR_MS) continue;
    const owner = (r.parent && ownerOf.get(r.parent)) || PAI;
    const thread: AgentThread = { sessionId: r.sessionId, shortId: r.shortId, title: r.title, project: r.project, state: r.state, threadId: r.threadId, lastActivity: r.lastActivity, costUsd: r.costUsd };
    out.set(owner, [...(out.get(owner) ?? []), thread]);
  }
  return out;
}

export function tree(openTasks: Record<string, number>) {
  const threads = threadsByAgent();
  return list().map((a) => ({
    ...a,
    threads: threads.get(a.slug) ?? [],
    depth: depth(a.slug),
    breadcrumb: breadcrumb(a.slug),
    openTasks: openTasks[a.slug] ?? 0,
    unresolvedTools: unresolved(a.tools),
    queued: queue.filter((q) => q.slug === a.slug).length,
    session: a.sessionId ? (sessions.find(a.sessionId)?.summary() ?? null) : null,
  }));
}
