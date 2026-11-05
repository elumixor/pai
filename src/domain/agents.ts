import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { bus, type PaiEvent } from "../core/bus.ts";
import { config } from "../core/config.ts";
import { db, kv, now } from "../core/db.ts";
import { logger } from "../core/log.ts";
import { day } from "../core/time.ts";
import * as asks from "./asks.ts";
import * as drafts from "./drafts.ts";
import * as agentPage from "./agent-page.ts";
import { attach, type Upload } from "./attachments.ts";
import { narrowed, unresolved } from "./capabilities.ts";
import { isLimit, limitLine, resetAt } from "./limits.ts";
import { get as getProject } from "./projects.ts";
import * as journal from "./journal.ts";
import * as keepLinks from "./keep-links.ts";
import * as messages from "./messages.ts";
import * as people from "./people.ts";
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
 * Each works from a Keep page, its brief and tracker, on which it is the assignee: a person in People's Pai group.
 *
 * - `orchestrator`: pai, the one voice the user hears (main.ts holds its session).
 * - `sub`: a worker, one bounded job for its parent; reports and stays open for follow-ups until closed.
 * - `standing`, `service`: history, rows of an older model.
 */

export type AgentKind = "orchestrator" | "standing" | "sub" | "service";
/** `waiting`: on an answer to its question. `paused`: the user stopped it and has not said why yet. `done`: reported. */
export type AgentStatus = "idle" | "queued" | "working" | "waiting" | "paused" | "done" | "closed";

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
  /** Reports that reach it from the agents and threads under it go on to its own parent too. */
  readonly bubble: boolean;
  readonly status: AgentStatus;
  readonly sessionId: string | null;
  readonly threadId: number | null;
  readonly cardId: number | null;
  readonly turnsToday: number;
  readonly costUsd: number;
  readonly createdAt: number;
  readonly lastActive: number;
  readonly closedAt: number | null;
  /** The Keep page it works from and is tracked on, `keep:page/<id>`. */
  readonly keepPage: string | null;
  /** Who it is in People: what Keep assigns the page to. */
  readonly personId: string | null;
  /** The session whose thread tag the page was last set up under. */
  readonly pageSession: string | null;
  readonly pausedAt: number | null;
  readonly pauseReason: string | null;
  readonly doneAt: number | null;
  readonly trashedAt: number | null;
}

export const PAI = "pai";
const GENERAL = "General";
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
  bubble: r.bubble !== 0,
  status: r.status,
  sessionId: r.session_id ?? null,
  threadId: r.thread_id ?? null,
  cardId: r.card_id ?? null,
  turnsToday: r.turns_day === day() ? r.turns_today : 0,
  costUsd: r.cost_usd,
  createdAt: r.created_at,
  lastActive: r.last_active,
  closedAt: r.closed_at ?? null,
  keepPage: r.keep_page ?? null,
  personId: r.person_id ?? null,
  pageSession: r.page_session ?? null,
  pausedAt: r.paused_at ?? null,
  pauseReason: r.pause_reason ?? null,
  doneAt: r.done_at ?? null,
  trashedAt: r.trashed_at ?? null,
});

export class AgentError extends Error {}

export function get(slug: string): Agent | undefined {
  const row = db.query("SELECT * FROM agents WHERE slug = ?").get(slug) as Record<string, any> | undefined;
  return row ? toAgent(row) : undefined;
}

export function list(opts: { closed?: boolean; parent?: string } = {}): Agent[] {
  const rows = db.query("SELECT * FROM agents WHERE trashed_at IS NULL ORDER BY created_at").all() as Record<string, any>[];
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

/** pai is depth 1, its workers 2, theirs 3. */
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

/** The chain of agents under one, itself first. */
const subtree = (a: Agent): Agent[] => [a, ...list({ parent: a.slug }).flatMap(subtree)];

/** Whether `slug` sits anywhere under `above`. */
export const isUnder = (slug: string, above: string) => lineage(slug).some((a) => a.slug === above && a.slug !== slug);

/** Who answers for an agent: the agent above it. */
export const supervisorOf = (slug: string) => (slug === PAI ? null : (get(slug)?.parent ?? PAI));

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
function setStatus(slug: string, status: AgentStatus) {
  const before = get(slug)?.status;
  const a = set(slug, { status, last_active: now() });
  const onPage = status === "working" ? "working" : status === "waiting" || status === "paused" ? "waiting" : status === "done" ? "done" : undefined;
  if (a?.keepPage && onPage && before !== status) void agentPage.followStatus(a.keepPage, onPage, a.sessionId);
  return a;
}

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
  /** The Keep page holding its task: goal, context, rules, what done means. It is the brief; without a readable one nothing is made. */
  keepPage: string;
  /** MCP servers it may use, by name or part of one (gmail, linkedin, notion, calendar, browser…); omitted = its parent's. */
  tools?: string[] | null;
  model?: string | null;
  effort?: Effort | null;
  budget?: Partial<Budget>;
  /** A repo it works in: a coding agent, whose sessions run there. */
  project?: string | null;
  /** Anything to add to "read your page", sent with it as its first message. */
  note?: string;
  taskId?: number | null;
}

/** The orchestrator's row, made on first start. Its session lives in main.ts. */
export function ensurePai(): Agent {
  const existing = get(PAI);
  if (existing?.name === GENERAL) return existing;
  // What it is called in every crumb and row is General, whoever made the row.
  if (existing) return set(PAI, { name: GENERAL })!;
  db.prepare(
    "INSERT INTO agents (slug, name, kind, parent, brief, folder, status, created_at, last_active, budget) VALUES (?, ?, 'orchestrator', NULL, ?, ?, 'idle', ?, ?, '{}')",
  ).run(PAI, GENERAL, "The orchestrator: the one voice the user hears.", config.workspace, now(), now());
  return get(PAI)!;
}

export async function create(input: CreateInput, by: string = PAI): Promise<Agent> {
  ensurePai();
  const parentSlug = input.kind === "sub" ? (input.parent ?? by) : PAI;
  const parent = get(parentSlug);
  if (!parent || parent.status === "closed") throw new AgentError(`no agent ${parentSlug} to report to`);
  if (input.kind !== "sub" && by !== PAI) throw new AgentError("only pai creates standing and service agents; start a sub-agent instead");
  if (input.kind === "sub" && by !== PAI && by !== parentSlug) throw new AgentError("an agent starts workers only under itself");
  if (depth(parentSlug) + 1 > MAX_DEPTH) throw new AgentError(`depth is capped at ${MAX_DEPTH}: ${parent.name} cannot start workers; make it a to-do in its own work`);
  if (!input.name?.trim()) throw new AgentError("an agent needs a name");
  if (input.project && !getProject(input.project)) throw new AgentError(`no project ${input.project}`);
  if (!input.keepPage?.trim()) throw new AgentError("an agent needs a Keep page: find or create the task's page first, with its goal and what done means");
  const keepPage = keepLinks.pageUrn(input.keepPage);
  const page = await agentPage.read(keepPage).catch((err: Error) => {
    throw new AgentError(`cannot read ${keepPage}: ${err.message}`);
  });
  const brief = page.body?.trim() ?? "";
  if (!brief) throw new AgentError(`${keepPage} has no text: write the task on the page first (goal, context, what done means)`);

  // A sub-agent gets at most its parent's tools, never more.
  let tools = input.tools === undefined ? parent.tools : input.tools;
  if (parent.tools && tools) tools = narrowed(tools, parent.tools);
  else if (parent.tools && !tools) tools = parent.tools;

  const slug = freeSlug(input.name);
  const folder = input.kind === "sub" && parent.kind !== "orchestrator" ? join(parent.folder, "sub", slug) : join(config.workspace, "agents", slug);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "CLAUDE.md"), roleFile(input.name, keepPage));
  if (!existsSync(join(folder, "STATE.md"))) writeFileSync(join(folder, "STATE.md"), `# State\n\nNothing yet: ${input.name} was just created (${day()}).\n`);

  const budget = { ...(input.kind === "sub" ? SUB_BUDGET : DEFAULT_BUDGET), ...input.budget };
  db.prepare(
    `INSERT INTO agents (slug, name, kind, parent, brief, keep_page, folder, project, tools, model, effort, budget, status, created_at, last_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?)`,
  ).run(slug, input.name.trim(), input.kind, parentSlug, brief, keepPage, folder, input.project ?? null, tools ? JSON.stringify(tools) : null, input.model ?? null, input.effort ?? null, JSON.stringify(budget), now(), now());
  const agent = get(slug)!;
  log.info(`created ${agent.kind} ${slug} under ${parentSlug}`);
  warnUnresolved(agent);
  messages.event(slug, input.kind === "sub" ? "agent.spawned" : "agent.created", `${parent.name} ${input.kind === "sub" ? "started" : "created"} ${agent.name}`, { from: parentSlug, to: parentSlug, meta: { brief, keep: keepPage, pageTitle: page.title } });
  bus.emitEvent("agent.created", agent as unknown as Record<string, unknown>);
  void syncPage(agent);
  message(slug, `Your task is the Keep page ${keepPage} ("${page.title}"). Read it with read_page and work from it.${input.note?.trim() ? `\n\n${input.note.trim()}` : ""}`, { from: parentSlug, kind: "delegate", taskId: input.taskId });
  return get(slug)!;
}

/**
 * Sets an agent's page up as far as it can: its person in People, the assignment, its session's watch. Each step is
 * written only once it worked, and the minute tick calls this again until everything is there, so a People or Keep
 * outage delays it rather than losing it.
 */
const syncing = new Set<string>();
async function syncPage(a: Agent) {
  if (!a.keepPage || a.kind === "orchestrator" || syncing.has(a.slug)) return;
  const sessionId = get(a.slug)?.sessionId ?? null;
  if (a.personId && a.pageSession === sessionId) return;
  syncing.add(a.slug);
  try {
    let personId = a.personId;
    if (!personId) {
      personId = await people.addMember(a.name, `${config.baseUrl}/#/chat/${a.slug}`);
      set(a.slug, { person_id: personId });
      await agentPage.assign(a.keepPage, `people:person/${personId}`, sessionId);
    }
    if (sessionId) {
      await agentPage.watch(a.keepPage, sessionId);
      keepLinks.link(a.keepPage, sessionId, { replace: true });
      set(a.slug, { page_session: sessionId });
    }
  } catch (err) {
    log.warn(`${a.slug}: page not set up yet: ${(err as Error).message}`);
  } finally {
    syncing.delete(a.slug);
  }
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

/** An agent's CLAUDE.md: who it is and where its task lives, with its STATE.md pulled in, so a fresh session starts knowing both. */
function roleFile(name: string, keepPage: string) {
  return `# ${name}\n\nYour task is the Keep page ${keepPage}: goal, context, rules and what done means are there, and it may change. Read it with read_page when you start, and keep what you find and how it stands on it.\n\n## Where things stand\n\n@STATE.md\n`;
}

/** Changes what an agent runs with; its session restarts on the next message. */
export function configure(slug: string, changes: { tools?: string[] | null; model?: string | null; effort?: Effort | null; budget?: Partial<Budget>; priority?: number; name?: string; parent?: string; bubble?: boolean }) {
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
  if (changes.tools !== undefined) fields.tools = changes.tools ? JSON.stringify(changes.tools) : null;
  if (changes.model !== undefined) fields.model = changes.model;
  if (changes.effort !== undefined) fields.effort = changes.effort;
  if (changes.budget) fields.budget = JSON.stringify({ ...a.budget, ...changes.budget });
  if (changes.priority !== undefined) fields.priority = Math.max(-2, Math.min(2, Math.round(changes.priority)));
  if (changes.bubble !== undefined) fields.bubble = changes.bubble ? 1 : 0;
  const updated = set(slug, fields);
  if (changes.tools !== undefined && updated) warnUnresolved(updated);
  // Tools and model are fixed when a process starts; the next message starts one with these.
  if (changes.tools !== undefined || changes.model !== undefined || changes.effort !== undefined) sessionOf(a)?.kill();
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
  const parent = a.kind === "sub" && a.parent ? get(a.parent) : undefined;
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
  const updated = set(a.slug, { session_id: s.id });
  if (updated) void syncPage(updated);
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
 * Turns the account's own limit stopped, with the moment the window reopens. They are kept on
 * disk, so a daemon restart in the meantime does not lose them either; `drainHeld` sends them
 * again. Without this a turn that hit the limit was simply gone, and someone had to notice and
 * re-send it by hand.
 */
interface Held extends Pending {
  at: number;
}
/** A held turn whose moment is not a time: the agent resuming. */
const UNTIL_RESUMED = Number.MAX_SAFE_INTEGER;
const HELD_KEY = "agent_held";
const held: Held[] = (() => {
  try {
    return JSON.parse(kv.get(HELD_KEY) ?? "[]") as Held[];
  } catch {
    return [];
  }
})();
const saveHeld = () => kv.set(HELD_KEY, JSON.stringify(held));

/** Drops every turn waiting to run, in memory and on disk, for when the agents themselves are going. */
export function forgetAll() {
  for (const timer of turnTimers.values()) clearTimeout(timer);
  turnTimers.clear();
  queue.length = 0;
  held.length = 0;
  lastWake.clear();
  saveQueue();
  saveHeld();
}

/** What each agent was last woken with, so a turn the limit killed can be sent again verbatim. */
const lastWake = new Map<string, Pending>();

/** The turns whose window has reopened, sent again. */
export function drainHeld(now = Date.now()) {
  const due = held.filter((h) => h.at <= now);
  if (!due.length) return;
  const rest = held.filter((h) => h.at > now);
  held.length = 0;
  held.push(...rest);
  saveHeld();
  for (const h of due) {
    const a = get(h.slug);
    if (!a || a.status === "closed") continue;
    log.info(`${h.slug}: the limit window reopened, sending its turn again`);
    messages.event(h.slug, "rate_limited", `${a.name} picks up the turn the account's limit stopped`, { to: reportsTo(a) });
    wake(h.slug, h.text, h.requestId, h.taskId);
  }
}

/** A turn the limit killed: nothing said, nothing reported, and the same turn sent again later. */
function limitHit(a: Agent, text: string) {
  const at = resetAt(text);
  const pending = lastWake.get(a.slug);
  setStatus(a.slug, "idle");
  messages.event(a.slug, "rate_limited", limitLine(a.name, at), { to: reportsTo(a) });
  if (!pending) return log.warn(`${a.slug} hit the limit with no turn to hold`);
  held.push({ ...pending, at });
  saveHeld();
  log.info(`${a.slug} hit the account's limit; its turn is held until ${new Date(at).toISOString()}`);
}

/**
 * The turns each agent has been sent and not finished, oldest first, with the request a turn
 * answers (0 for none) and the task it is about: a session queues turns, so the head is the one
 * whose end comes next. The task's thread gets the turn's report.
 */
const answering = new Map<string, { requestId: number; taskId: number | null }[]>();
const turnTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Whose running turn was cut off, by anyone: what it had written by then is no report. */
const interrupted = new Set<string>();
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
  /** What the chat shows, when the text the agent is woken with carries more (attachment paths). */
  body?: string;
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
  const row = opts.logged ? undefined : messages.log({ from: opts.from, to: slug, kind: opts.kind ?? "chat", body: opts.body ?? text, taskId: opts.taskId, meta: { ...opts.meta, requestId: opts.requestId } });
  const prefix = opts.from === "user" ? "[the user, writing to you directly]" : opts.from === PAI ? "[pai]" : `[${get(opts.from)?.name ?? opts.from}]`;
  wake(slug, `${prefix} ${text}${opts.taskId ? `\n\n(task #${opts.taskId})` : ""}`, opts.requestId, opts.taskId);
  return row;
}

function wake(slug: string, text: string, requestId?: number, taskId?: number | null) {
  const a = get(slug)!;
  // Paused on the user: what the others send waits for them to resume it.
  if (a.status === "paused") {
    held.push({ slug, text, requestId, taskId, at: UNTIL_RESUMED });
    saveHeld();
    return;
  }
  lastWake.set(slug, { slug, text, requestId, taskId });
  if (a.turnsToday >= a.budget.turnsPerDay) {
    messages.event(slug, "error", `${a.name} hit its budget of ${a.budget.turnsPerDay} turns today; not woken`, { to: reportsTo(a) });
    tellOwner(a, `${a.name} hit its budget (${a.budget.turnsPerDay} turns a day) and was not woken. Raise it with configure_agent if the work should go on.`);
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
  if (a.doneAt) set(a.slug, { done_at: null });
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
      interrupted.add(a.slug);
      void s.interrupt();
      messages.event(a.slug, "error", `${a.name}'s turn ran past ${a.budget.turnMinutes} minutes and was stopped`, { to: reportsTo(a) });
      tellOwner(a, `${a.name}'s turn ran past its ${a.budget.turnMinutes}-minute budget and was interrupted.`);
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
export function deliver(slug: string, text: string, opts: { taskId?: number | null; byUser?: boolean } = {}) {
  const a = get(slug);
  if (!a || a.status === "closed") return;
  if (a.status === "paused" && opts.byUser) resume(slug);
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
export function fromUser(slug: string, text: string, taskId?: number | null, images?: readonly Upload[]) {
  const a = get(slug);
  if (!a) throw new AgentError(`no agent ${slug}`);
  if (a.status === "paused") resume(slug, { saying: true });
  // An agent is woken with text, so its pictures travel as the file paths it can open itself.
  const pictures = attach(images);
  const row = message(slug, pictures.refs ? `${text}\n\n${pictures.refs}`.trim() : text, { from: "user", kind: "chat", taskId, meta: pictures.meta, body: text });
  notePai(`[the user stepped into ${breadcrumb(slug)}'s chat] ${text.replace(/\s+/g, " ").slice(0, 200)}`);
  return row;
}

// ---- reports ---------------------------------------------------------------

/** How a report reaches pai: main.ts registers these, so this file does not import it. */
interface PaiLink {
  note(text: string): void;
  /** A report: what it needs is screened first. */
  turn(text: string): void;
  /** Something pai must answer: a turn, always. */
  direct(text: string): void;
}
let paiLink: PaiLink = { note: () => {}, turn: () => {}, direct: () => {} };
export function linkPai(link: PaiLink) {
  paiLink = link;
}
const notePai = (text: string) => paiLink.note(text);

const notYetRun = (slug: string) => ["paused", "queued"].includes(get(slug)?.status ?? "");

/** The card's approval reaches whoever offered it. Whatever stops that turn is said on the card: it is never left "sending". */
function wakeToSend(slug: string, draftId: number, text: string, byPin: boolean) {
  const a = get(slug);
  if (!a) return drafts.fail(draftId, `${slug} no longer exists. Offer it again from another agent.`);
  if (a.kind === "orchestrator") return paiLink.direct(text);
  if (a.status === "closed") return drafts.fail(draftId, `${a.name} is closed, so it cannot send this.`);
  if (a.turnsToday >= a.budget.turnsPerDay) return drafts.fail(draftId, `${a.name} has used its turns for today (${a.budget.turnsPerDay}). Try again tomorrow or raise its budget.`);
  message(slug, text, { from: byPin ? PAI : "user", kind: "chat", logged: true });
}

/** A question a supervisor holds: a row in its chat and a turn, so it settles it or passes it on. */
export function askSupervisor(holder: string, ask: { readonly id: number; readonly agent: string; readonly question: string; readonly options: readonly string[]; readonly taskId: number | null }) {
  const asker = get(ask.agent);
  const name = asker?.name ?? ask.agent;
  const text = `${name} asks (question #${ask.id}): ${ask.question}${ask.options.length ? `\nOptions: ${ask.options.join(" / ")}` : ""}\n\nDecide it with answer_ask if it is yours to decide from what you know. If it is the user's to decide (their taste, money, anything only they know) or you cannot tell, pass it on with elevate_ask. Either way, do it now.`;
  if (holder === PAI) {
    messages.log({ from: ask.agent, to: PAI, kind: "request", body: ask.question, taskId: ask.taskId, meta: { askId: ask.id, agent: ask.agent } });
    paiLink.direct(`[${text}]`);
    return;
  }
  message(holder, text, { from: ask.agent, kind: "request", body: ask.question, taskId: ask.taskId, meta: { askId: ask.id, agent: ask.agent } });
}

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

/**
 * Who an agent's work answers to: the agent above it, whoever that is. From there it goes on up only as
 * far as each agent in the chain lets it (`bubble`); pai is the top. A report delivered to an agent that
 * cannot act on it is a wasted turn, so an agent that holds its own area turns bubbling off.
 */
function reportChain(a: Agent): string[] {
  const chain: string[] = [];
  for (let to = a.parent ?? PAI; ; ) {
    chain.push(to);
    const p = get(to);
    if (to === PAI || !p || !p.bubble) return chain;
    to = p.parent ?? PAI;
  }
}

/** The first stop of a report: the agent above. */
function reportsTo(a: Agent) {
  return reportChain(a)[0]!;
}

/** Hands something to each agent in a chain: pai as a batched turn, another as a line in its session. */
function reportUp(chain: readonly string[], forPai: string, forAgent: (parent: Agent) => void) {
  for (const to of chain) {
    if (to === PAI) {
      toPai(forPai);
      continue;
    }
    const p = get(to);
    if (p && p.status !== "closed") forAgent(p);
  }
}

function tellOwner(a: Agent, text: string) {
  reportUp(reportChain(a), `[${a.name}] ${text}`, (p) => sessionOf(p)?.inject(`[${a.name}] ${text}`));
}

/** Something its supervisor should know and need not act on: no turn is spent on it. */
function noteOwner(a: Agent, text: string) {
  const parent = a.parent ?? PAI;
  if (parent === PAI) notePai(`[${a.name}] ${text}`);
  else noteTo(parent, `[${a.name}] ${text}`);
}

/** An agent marks itself waiting on the user (a blocking ask); its next turn end is not a report. */
export function park(slug: string) {
  setStatus(slug, "waiting");
}

function turnEnded(a: Agent, payload: Record<string, unknown>) {
  clearTimeout(turnTimers.get(a.slug));
  const text = String(payload.text ?? "").trim();
  // The account's limit, not an answer: held and sent again, never reported as what came of the work.
  if (isLimit(text)) return limitHit(a, text);
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

  // Cut off, by the user, a supervisor or its time budget: what it had written so far is no report.
  const cutOff = interrupted.delete(a.slug) || Boolean(payload.isError);
  if (current.status === "paused") return drain();
  const waiting = current.status === "waiting";
  if (!waiting) setStatus(a.slug, pending.length ? "working" : "idle");
  checkState(current);

  // A parked agent's "asked, waiting" is not a report, nor is a turn that ended with its own workers still at it:
  // their reports bring the next turn.
  const staffBusy = list({ parent: a.slug }).some((c) => ["working", "queued", "waiting", "paused"].includes(c.status));
  if (text && !ids.length && !waiting && !cutOff && !staffBusy) {
    const report = String(payload.final ?? text).trim().slice(0, REPORT_CHARS);
    if (current.kind === "sub" && !pending.length) {
      setStatus(a.slug, "done");
      set(a.slug, { done_at: now() });
    }
    const chain = reportChain(current);
    messages.log({ from: a.slug, to: chain[0]!, kind: "report", body: report, taskId, meta: { agent: a.slug } });
    reportUp(chain, `[${a.name} reported]\n${report}`, (parent) => message(parent.slug, `${a.name} reported:\n${report}`, { from: a.slug, kind: "report", taskId, meta: { agent: a.slug }, logged: parent.slug === chain[0] }));
  }
  drain();
}

function turnFailed(a: Agent, message: string) {
  clearTimeout(turnTimers.get(a.slug));
  answering.get(a.slug)?.shift();
  setStatus(a.slug, "idle");
  messages.event(a.slug, "error", `${a.name} failed: ${message}`, { to: reportsTo(a) });
  tellOwner(a, `failed: ${message}`);
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
  // Revived sessions find their agent's role and tools through this; registered here, not at import, because these files import each other.
  sessions.resolveAgentsWith((slug) => {
    const a = get(slug);
    return a ? setupOf(a) : undefined;
  });
  // Agents that were mid-turn when the daemon stopped are resumed by sessions.resumeInterrupted; the rest are idle.
  for (const a of list()) if (a.kind !== "orchestrator" && (a.status === "working" || a.status === "queued") && !queue.some((q) => q.slug === a.slug)) setStatus(a.slug, "idle");
  const handler = (e: PaiEvent) => {
    if (e.kind === "session.input" && e.sessionId && e.sessionId === get(PAI)?.sessionId) return void setStatus(PAI, "working");
    // Thinking or a tool call is a turn in flight, whoever started it: a turn resumed after a
    // restart is never woken, so this is the only thing that says it is working.
    if ((e.kind === "session.delta" || e.kind === "session.tool") && e.sessionId) {
      const at = bySession(e.sessionId);
      if (at && at.kind !== "orchestrator" && at.status === "idle") setStatus(at.slug, "working");
      return;
    }
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
  // His Send on a draft card: the agent that offered it sends it, with the fields as they stand.
  const onDraft = (e: PaiEvent) => {
    const slug = String(e.payload.agent ?? "");
    if (e.kind === "draft.sending") wakeToSend(slug, Number(e.payload.id), String(e.payload.text ?? ""), e.payload.by === "pin");
    else if (e.kind === "draft.discarded" && !String(e.payload.why ?? "").startsWith("withdrawn")) {
      const text = `[The user discarded draft #${e.payload.id}: nothing was sent. Do not offer it again unless they ask.]`;
      if (slug === PAI) notePai(text);
      else noteTo(slug, text);
    } else if (e.kind === "draft.settled" && e.payload.by === "pin" && e.payload.state !== "verified") {
      asks.ask({ agent: slug, question: `A message set to send by itself ended ${e.payload.state}: draft #${e.payload.id}. ${e.payload.note ?? ""}`.trim(), options: ["Seen"], blocking: false, fallback: "Carry on", forUser: true });
    }
  };
  bus.on("event", onDraft);

  bus.on("event", handler);
  setTimeout(drain, 5_000);
  const settling = setInterval(() => (settle(), drainHeld(), closeFinished(), catchUpPages(), drafts.sweepStuck(notYetRun)), SETTLE_EVERY_MS);
  return () => {
    clearInterval(settling);
    bus.off("event", handler);
    bus.off("event", onDraft);
  };
}

/** How often a status that cannot be true any more is corrected. */
const SETTLE_EVERY_MS = 60_000;

/**
 * A status that is no longer true, in either direction. `working` is written on a wake and cleared
 * by the turn's own end, so both halves can go stale: a turn that never ends (the session gone, or
 * the daemon restarted by the very release that turn cut) leaves an agent working for ever, and a
 * turn the daemon did not send — one resumed after a restart — leaves it idle while it works. Both
 * are the same lie, and the second is the one he cannot catch by waiting. So the status is derived
 * from whether a session of its own is alive and busy, not from what was written when it started.
 */
export function settle() {
  for (const a of list()) {
    if (a.kind === "orchestrator" || a.status === "closed" || a.status === "queued" || a.status === "waiting" || a.status === "paused") continue;
    const s = a.sessionId ? sessions.find(a.sessionId) : undefined;
    const alive = s && s.state !== "dead";
    const busy = Boolean(alive && (s.state === "busy" || s.state === "starting") && !s.pending);
    if (busy && a.status !== "working") {
      if (a.status === "done") set(a.slug, { done_at: null });
      log.info(`${a.slug} has a turn running and was marked ${a.status}; working`);
      setStatus(a.slug, "working");
      continue;
    }
    if (a.status !== "working" || alive) continue;
    log.info(`${a.slug} was marked working with no live session; idle`);
    setStatus(a.slug, "idle");
    drain();
  }
}

/** Workers finished long enough ago close by themselves; a follow-up in time keeps them open. */
function closeFinished() {
  const before = now() - config.doneCloseHours * 3_600_000;
  for (const a of list()) if (a.status === "done" && a.doneAt && a.doneAt < before) close(a.slug, "finished");
}

/** What an earlier People or Keep outage left undone. */
function catchUpPages() {
  for (const a of list()) void syncPage(a);
}

// ---- stopping --------------------------------------------------------------

/** Interrupts the agents' running turns and drops what they had waiting, each and every one given. The slugs that were at something. */
async function cutOff(targets: readonly Agent[]): Promise<string[]> {
  const stopped: string[] = [];
  for (const target of targets) {
    if (target.status === "closed") continue;
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i]!.slug === target.slug) queue.splice(i, 1);
    for (let i = held.length - 1; i >= 0; i--) if (held[i]!.slug === target.slug) held.splice(i, 1);
    clearTimeout(turnTimers.get(target.slug));
    const s = sessionOf(target);
    const busy = s?.state === "busy";
    if (busy) {
      interrupted.add(target.slug);
      await s!.interrupt();
    }
    if (busy || target.status === "working" || target.status === "queued") {
      if (target.status === "queued" || !busy) setStatus(target.slug, "idle");
      stopped.push(target.slug);
    }
  }
  saveQueue();
  saveHeld();
  return stopped;
}

/**
 * The user stopped an agent, maybe saying nothing. It waits on them: paused, with a need that reminds them until they
 * resume it, write to it or kill it. Its supervisor is told without a turn, and what the supervisor sends meanwhile
 * waits. Those below it are stopped too and left idle for it to pick up. The slugs that stopped.
 */
export async function stop(slug: string, reason = ""): Promise<string[]> {
  const a = get(slug);
  if (!a || a.kind === "orchestrator") throw new AgentError(`no agent ${slug}`);
  // Marked first: the interrupted turn's end finds it paused and reports nothing.
  const wasPaused = a.status === "paused";
  const active = a.status === "working" || a.status === "queued" || sessionOf(a)?.state === "busy";
  if (active) set(slug, { status: "paused", paused_at: now(), pause_reason: reason || null });
  const stopped = await cutOff(subtree(get(slug)!));
  if (!active && !wasPaused && stopped.length === 0) return [];
  if (active) {
    void (a.keepPage && agentPage.followStatus(a.keepPage, "waiting", a.sessionId));
    messages.event(slug, "stopped", `${a.name} stopped by the user${reason ? `: ${reason}` : ""}`, { to: a.parent ?? PAI });
    noteOwner(a, `The user stopped ${a.name}${reason ? `: ${reason}` : ""}. It waits on them; do not restart it.`);
  }
  drain();
  return stopped;
}

/** A supervisor stops an agent under it: nothing waits on the user, the agent is told why on its next turn. */
export async function stopBy(by: string, slug: string, reason: string): Promise<string[]> {
  const a = get(slug);
  if (!a) throw new AgentError(`no agent ${slug}`);
  const stopped = await cutOff(subtree(a));
  messages.event(slug, "stopped", `${get(by)?.name ?? by} stopped ${a.name}: ${reason}`, { from: by, to: by });
  noteTo(slug, `[${get(by)?.name ?? by} stopped you: ${reason}]`);
  drain();
  return stopped;
}

/** Back to work after the user's stop: told what happened, and handed what was sent to it meanwhile. */
export function resume(slug: string, opts: { saying?: boolean } = {}) {
  const a = get(slug);
  if (!a) throw new AgentError(`no agent ${slug}`);
  if (a.status !== "paused") return a;
  set(slug, { status: "idle", paused_at: null, pause_reason: null, last_active: now() });
  messages.event(slug, "resumed", `${a.name} resumed by the user`, { to: a.parent ?? PAI });
  db.prepare("DELETE FROM reminders WHERE need = ?").run(`paused:${slug}`);
  const note = `[the user stopped you earlier${a.pauseReason ? `: ${a.pauseReason}` : ""}, and your turn was cut off there.`;
  if (opts.saying) noteTo(slug, `${note} They are writing to you now.]`);
  else wake(slug, `${note} They resumed you without further instructions: carry on from where you were.]`);
  const waited = held.filter((h) => h.slug === slug && h.at === UNTIL_RESUMED);
  const rest = held.filter((h) => !waited.includes(h));
  held.length = 0;
  held.push(...rest);
  saveHeld();
  for (const h of waited) wake(h.slug, h.text, h.requestId, h.taskId);
  noteOwner(a, `The user resumed ${a.name}.`);
  return get(slug)!;
}

// ---- closing ---------------------------------------------------------------

/** Takes an agent and those below it off work: session, queue, what it held, its open questions, its routines. */
function retire(a: Agent, opts: { killBusy: boolean }) {
  clearTimeout(turnTimers.get(a.slug));
  const s = sessionOf(a);
  if (s && (opts.killBusy || s.state !== "busy")) s.kill();
  const index = queue.findIndex((q) => q.slug === a.slug);
  if (index >= 0) {
    queue.splice(index, 1);
    saveQueue();
  }
  for (let i = held.length - 1; i >= 0; i--) if (held[i]!.slug === a.slug) held.splice(i, 1);
  saveHeld();
  db.prepare("UPDATE asks SET status = 'dropped', answered_at = ? WHERE status = 'open' AND agent = ?").run(now(), a.slug);
  db.prepare("DELETE FROM reminders WHERE need = ?").run(`paused:${a.slug}`);
  // Routines that would wake it, or that it kept for itself, go with it.
  db.prepare("DELETE FROM automations WHERE agent = ? OR owner = ?").run(a.slug, a.slug);
  bus.emitEvent("ask.answered", { agent: a.slug });
}

/** Done: the session goes, the folder is archived, a line goes into the journal. Its workers close with it. */
export function close(slug: string, summary = "", opts: { by?: string; killBusy?: boolean } = {}): Agent {
  const a = get(slug);
  if (!a || a.kind === "orchestrator") throw new AgentError(`no agent ${slug}`);
  if (a.status === "closed") return a;
  for (const child of list({ parent: slug })) close(child.slug, `closed with ${a.name}`, opts);
  retire(a, { killBusy: opts.killBusy ?? false });
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
  const closed = set(slug, { status: "closed", closed_at: now(), folder, paused_at: null, pause_reason: null })!;
  const done = a.status === "done";
  if (a.keepPage) void agentPage.followStatus(a.keepPage, done ? "closed" : "dropped", a.sessionId);
  journal.append(`${a.name} (${a.kind}) closed${summary ? `: ${summary}` : ""}`);
  messages.event(slug, "agent.closed", `${a.name} closed${opts.by ? ` by ${opts.by}` : ""}${summary ? `: ${summary}` : ""}`, { to: a.parent ?? PAI });
  return closed;
}

/** The user killed an agent, maybe saying why: it closes now, even mid-turn, and whoever it worked for hears. */
export function kill(slug: string, reason = ""): Agent {
  const a = get(slug);
  if (!a) throw new AgentError(`no agent ${slug}`);
  const closed = close(slug, reason, { by: "the user", killBusy: true });
  noteOwner(a, `The user killed ${a.name}${reason ? `: ${reason}` : ""}. Do not restart it unless they ask.`);
  return closed;
}

// ---- the trash -------------------------------------------------------------

/** Read when asked: this file and sessions.ts import each other, so it is not there yet at import. */
export const trashDays = () => sessions.TRASH_DAYS;

/** To the trash, those below it too: nothing runs, its chat and sessions are out of sight, and it can come back for 30 days. */
export function trash(slug: string): readonly string[] {
  const a = get(slug);
  if (!a || a.kind === "orchestrator") throw new AgentError(`no agent ${slug}`);
  const at = now();
  const all = subtree(a);
  for (const target of all) {
    retire(target, { killBusy: true });
    sessions.trashOfAgent(target.slug);
    set(target.slug, { trashed_at: at, status: "closed", closed_at: at, paused_at: null, pause_reason: null });
  }
  bus.emitEvent("agents.trashed", { slugs: all.map((t) => t.slug) });
  return all.map((t) => t.slug);
}

/** What went to the trash with one agent and that agent itself: rows sharing its moment. */
const trashedWith = (a: Agent) => (db.query("SELECT * FROM agents WHERE trashed_at = ?").all(a.trashedAt) as Record<string, any>[]).map(toAgent);

export const trashList = () => (db.query("SELECT * FROM agents WHERE trashed_at IS NOT NULL ORDER BY trashed_at DESC").all() as Record<string, any>[]).map(toAgent);

/** Back from the trash, with what went with it. It stays idle until someone writes to it. */
export function restore(slug: string): readonly string[] {
  const a = get(slug);
  if (!a?.trashedAt) throw new AgentError(`${slug} is not in the trash`);
  const back = trashedWith(a);
  for (const target of back) {
    sessions.restoreOfAgent(target.slug);
    set(target.slug, { trashed_at: null, status: "idle", closed_at: null });
  }
  bus.emitEvent("agents.restored", { slugs: back.map((t) => t.slug) });
  return back.map((t) => t.slug);
}

/** For good: its folder, sessions, row and person. The Keep page stays, what it found is written there. */
export function purge(slug: string): readonly string[] {
  const a = get(slug);
  if (!a?.trashedAt) throw new AgentError(`${slug} is not in the trash`);
  const gone = trashedWith(a);
  for (const target of gone) {
    sessions.purgeOfAgent(target.slug);
    rmSync(target.folder, { recursive: true, force: true });
    forgetPerson(target);
    db.prepare("DELETE FROM agents WHERE slug = ?").run(target.slug);
  }
  bus.emitEvent("agents.purged", { slugs: gone.map((t) => t.slug) });
  return gone.map((t) => t.slug);
}

/** Its person is of no use once it is gone. People keeps the row, so what was assigned to it still has a name. */
export function forgetPerson(a: Agent) {
  if (a.personId) void people.removeMember(a.personId).catch((err: Error) => log.warn(`${a.slug}: person not removed: ${err.message}`));
}

/** The trash empties itself of agents there longer than `trashDays`. */
export function purgeOld() {
  const before = now() - trashDays() * 86_400_000;
  for (const a of trashList()) if (a.trashedAt! < before && get(a.slug)) purge(a.slug);
}

/** Status, open work and spend per agent, for the tree view. */
/** A plain thread an agent started (or, with no agent behind it, one of pai's: terminal, a chat). */
export interface AgentThread {
  readonly sessionId: string;
  readonly shortId: string;
  readonly title: string;
  readonly project: string | null;
  readonly cwd: string | null;
  readonly kind: string;
  readonly state: string;
  readonly threadId: number | null;
  readonly startedAt: number;
  readonly lastActivity: number;
  readonly costUsd: number;
  readonly turns: number;
  readonly model: string | null;
  readonly modelPref: string | null;
  readonly effort: string | null;
  /** Where it was started: an agent (its owner), the client's detached box, the CLI, a terminal, the phone, the builder, a routine. */
  readonly origin: string;
}

const THREADS_SHOWN_FOR_MS = 7 * 86_400_000;

/** Where a thread came from when no origin was recorded (older rows, sources that do not say): a repo is the builder, a topic the phone, the rest a terminal. */
const originOf = (r: sessions.SessionRow, owned: boolean) => r.origin ?? (r.kind === "code" ? "builder" : owned ? "agent" : r.threadId !== null ? "phone" : "terminal");

/** Each agent's threads, by who started them: the session a thread's parent is belongs to an agent, or else to pai. */
function threadsByAgent(): Map<string, AgentThread[]> {
  const rows = sessions.recent(120);
  const ownerOf = new Map(list().filter((a) => a.sessionId).map((a) => [a.sessionId!, a.slug]));
  for (const r of rows) if (r.agent) ownerOf.set(r.sessionId, r.agent);
  const out = new Map<string, AgentThread[]>();
  for (const r of rows) {
    if (r.agent) continue;
    const live = r.state === "busy" || r.state === "starting";
    if (!live && now() - r.lastActivity > THREADS_SHOWN_FOR_MS) continue;
    const parentOwner = r.parent ? ownerOf.get(r.parent) : undefined;
    const owner = parentOwner || PAI;
    const thread: AgentThread = {
      sessionId: r.sessionId,
      shortId: r.shortId,
      title: r.title,
      project: r.project,
      cwd: r.cwd,
      kind: r.kind,
      state: r.state,
      threadId: r.threadId,
      startedAt: r.startedAt,
      lastActivity: r.lastActivity,
      costUsd: r.costUsd,
      turns: r.turns,
      model: r.model,
      modelPref: r.modelPref,
      effort: r.effort,
      origin: originOf(r, Boolean(parentOwner)),
    };
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
