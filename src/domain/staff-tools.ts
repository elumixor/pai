import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { config } from "../core/config.ts";
import * as agents from "./agents.ts";
import * as asks from "./asks.ts";
import * as automations from "./automations.ts";
import * as capabilities from "./capabilities.ts";
import * as messages from "./messages.ts";
import * as recall from "./recall.ts";
import { repeatOf } from "./repeats.ts";
import * as requests from "./requests.ts";
import * as settings from "./settings.ts";
import * as tasks from "./tasks.ts";
import { conversationDigest, conversations } from "./transcript.ts";

/**
 * The tools that make a session one of pai's staff, by role: pai (the orchestrator) runs the
 * show; a standing agent owns an area and may start sub-agents; a sub-agent does one job; a
 * service agent answers requests. A plain thread gets the task list and recall only.
 */

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (err: unknown) => ok({ error: (err as Error).message });
/** Runs a tool body, turning a thrown error into an answer the model can read. */
const guard =
  <A>(fn: (args: A) => unknown) =>
  async (args: A) => {
    try {
      return ok(await fn(args));
    } catch (err) {
      return fail(err);
    }
  };

const status = z.enum(tasks.STATUSES);
const priority = z.enum(asks.PRIORITIES);
const model = z.string().describe("opus for judgement and writing, sonnet for routine work, haiku for triage");

export type Role = "orchestrator" | "standing" | "sub" | "service" | "thread";

export function roleOf(slug: string | undefined): Role {
  if (!slug) return "thread";
  return agents.get(slug)?.kind ?? "thread";
}

const agentSummary = (a: agents.Agent) => ({
  slug: a.slug,
  name: a.name,
  kind: a.kind,
  parent: a.parent,
  status: a.status,
  brief: a.brief.split("\n")[0]!.slice(0, 200),
  tools: a.tools ?? "all",
  toolsMissing: capabilities.unresolved(a.tools),
  model: a.model ?? "default",
  project: a.project ?? undefined,
  turnsToday: a.turnsToday,
  costUsd: Number(a.costUsd.toFixed(3)),
});

/** Only pai sees every agent; an agent sees its own sub-agents. */
function mine(me: string, slug: string) {
  const a = agents.get(slug);
  if (!a) throw new Error(`no agent ${slug}`);
  if (me !== agents.PAI && a.parent !== me) throw new Error(`${slug} is not yours: you reach other agents with request`);
  return a;
}

/**
 * Whatever waits on the user belongs to an area: its card sits on that agent in the tree. pai
 * itself has no row there, so a decision it keeps for itself would be one no area shows.
 */
function inArea(owner: string) {
  if (owner === agents.PAI) throw new Error("a task waiting on the user belongs to an area: owner = that area's agent (list_agents; create one if none fits), never pai");
  if (!agents.get(owner)) throw new Error(`no agent ${owner}`);
}

/** The task a decision of pai's hangs on, checked to exist and to belong to an area. */
function areaOwned(taskId: number) {
  const t = tasks.get(taskId);
  if (!t) throw new Error(`no task #${taskId}`);
  inArea(t.owner);
}

export function staffTools(me: string | undefined) {
  const role = roleOf(me);
  const self = me ?? agents.PAI;
  const isPai = role === "orchestrator";
  const out = [];

  // ---- the task list: everyone reads it; agents write their own -----------------
  out.push(
    tool(
      "task_add",
      "Put a task on the user's list. The owner keeps it current. Sub-tasks name their parent.",
      {
        title: z.string(),
        owner: z.string().optional().describe(isPai ? "agent slug that owns it; default pai" : "default you"),
        parent_id: z.number().optional(),
        status: status.optional().describe("default inbox"),
        next_action: z.string().optional(),
        due: z.string().optional().describe("YYYY-MM-DD"),
        source: z.string().optional().describe("a Notion page, GitHub issue or email thread link"),
        notes: z.string().optional(),
      },
      guard((a: { title: string; owner?: string; parent_id?: number; status?: tasks.TaskStatus; next_action?: string; due?: string; source?: string; notes?: string }) => {
        if (a.status === "waiting_user") inArea(a.owner ?? self);
        return tasks.add({ title: a.title, owner: a.owner ?? self, parentId: a.parent_id, status: a.status, nextAction: a.next_action, due: a.due, source: a.source, notes: a.notes, createdBy: me ?? "thread" });
      }),
    ),
    tool(
      "task_update",
      "Change a task: status (inbox, active, waiting_user, waiting_other, scheduled, done, dropped), next action, due date, owner, notes.",
      {
        id: z.number(),
        title: z.string().optional(),
        status: status.optional(),
        next_action: z.string().optional(),
        due: z.string().nullable().optional(),
        owner: z.string().optional(),
        source: z.string().nullable().optional(),
        notes: z.string().optional(),
        parent_id: z.number().nullable().optional(),
      },
      guard((a: { id: number; title?: string; status?: tasks.TaskStatus; next_action?: string; due?: string | null; owner?: string; source?: string | null; notes?: string; parent_id?: number | null }) => {
        const t = tasks.get(a.id);
        if (!t) throw new Error(`no task #${a.id}`);
        if (!isPai && role !== "thread" && t.owner !== self && !agents.list({ parent: self }).some((c) => c.slug === t.owner)) throw new Error(`task #${a.id} belongs to ${t.owner}`);
        if ((a.status ?? t.status) === "waiting_user" && (a.status || a.owner)) inArea(a.owner ?? t.owner);
        return tasks.update(a.id, { title: a.title, status: a.status, nextAction: a.next_action, due: a.due, owner: a.owner, source: a.source, notes: a.notes, parentId: a.parent_id });
      }),
    ),
    tool(
      "task_list",
      isPai ? "The user's task list: open tasks by default, waiting-on-user first. Filter by owner or status." : "Your tasks (owner = you) unless you name another owner.",
      { owner: z.string().optional(), status: status.optional(), include_closed: z.boolean().optional(), parent_id: z.number().optional() },
      guard((a: { owner?: string; status?: tasks.TaskStatus; include_closed?: boolean; parent_id?: number }) =>
        tasks.list({ owner: a.owner ?? (isPai || role === "thread" ? undefined : self), status: a.status, open: !a.include_closed, parentId: a.parent_id }).map((t) => ({ ...t, line: undefined })),
      ),
    ),
    tool(
      "recall",
      "Search everything past: conversation transcripts, the message log between pai and its agents, mail and chat copies the watchers saw. Use good keywords (names, subjects); quotes for phrases.",
      { query: z.string(), sources: z.array(z.enum(["transcript", "message", "mail", "telegram", "linkedin", "calendar"])).optional(), limit: z.number().optional() },
      guard((a: { query: string; sources?: string[]; limit?: number }) => recall.search(a.query, { sources: a.sources, limit: a.limit })),
    ),
    tool(
      "conversations",
      "The user's own Claude Code conversations (terminal and app, both machines), newest first: id, project, title (their first prompt), last activity, size. pai's own sessions are not in it. Read one with conversation.",
      { days: z.number().optional().describe("how far back, default 60"), project: z.string().optional().describe("only this project"), limit: z.number().optional() },
      guard(async (a: { days?: number; project?: string; limit?: number }) => {
        const all = await conversations(a.days ?? 60, a.project ? 1000 : (a.limit ?? 300));
        return (a.project ? all.filter((c) => c.project === a.project) : all).slice(0, a.limit ?? 300);
      }),
    ),
    tool(
      "conversation",
      "One of the user's conversations as what was said — their prompts and the answers, without tool output — cut to max_chars (default 30000, the middle goes first).",
      { id: z.string(), max_chars: z.number().optional() },
      guard((a: { id: string; max_chars?: number }) => conversationDigest(a.id, a.max_chars)),
    ),
  );
  if (role === "thread") return out;

  // ---- reaching the user and each other ------------------------------------
  out.push(
    tool(
      "ask_user",
      `Ask the user a question; it reaches them through pai's chat (and their phone and watch) as a card with your name, answered with one tap. The question is one short line; options are two to four short choices — Yes / No, or A / B / C with the choice in each label, your recommendation first; they can still type an answer. blocking: you are parked until they answer and the answer arrives as a new message. Non-blocking: give a fallback you go on with now; you hear back only if they answer differently. A decision already waiting on them (open_asks, task_list status waiting_user) is not asked again: the call returns the open one.${isPai ? " Yours always names task_id: the task the decision is about, owned by the area's agent (task_add it first if there is none) — that is where the card shows." : ""}`,
      {
        question: z.string(),
        options: z.array(z.string().max(40)).max(4).optional(),
        allow_free_text: z.boolean().optional().describe("default true"),
        priority: priority.optional().describe("urgent: minutes to act; normal (default); digest: can wait for the brief"),
        blocking: z.boolean().optional().describe("default true"),
        fallback: z.string().optional().describe("what you do meanwhile, for a non-blocking ask"),
        context: z.string().optional().describe("where it comes from, shown after your name: 'Candidate replies'"),
        task_id: isPai ? z.number() : z.number().optional(),
      },
      guard(async (a: { question: string; options?: string[]; allow_free_text?: boolean; priority?: asks.Priority; blocking?: boolean; fallback?: string; context?: string; task_id?: number }) => {
        if (isPai) areaOwned(a.task_id!);
        const already = asks.pending({ agent: self, question: a.question, taskId: a.task_id });
        if (already) return { ask: already.id, duplicate: true, note: `Already waiting on the user as ask #${already.id} ("${already.question}"); not asked again.` };
        const repeat = await repeatOf(a.question, a.task_id);
        if (repeat?.kind === "ask") return { ask: repeat.ask.id, duplicate: true, note: `The same decision already waits on the user as ask #${repeat.ask.id} ("${repeat.ask.question}"); not asked again.` };
        if (repeat?.kind === "task") return { task: repeat.task.id, duplicate: true, note: `The same decision already waits on the user as task #${repeat.task.id} ("${repeat.task.title}"); not asked again. To put options on it, ask again with task_id ${repeat.task.id}.` };
        const asked = asks.ask({ agent: self, question: a.question, options: a.options, freeText: a.allow_free_text, priority: a.priority, blocking: a.blocking, fallback: a.fallback, context: a.context, taskId: a.task_id });
        if (a.task_id && (asked.blocking || isPai)) tasks.update(a.task_id, { status: "waiting_user" });
        return { ask: asked.id, delivered: asked.delivered, note: asked.blocking ? "End your turn now; the answer comes as a new message." : `Go on with: ${asked.fallback}` };
      }),
    ),
  );
  if (!isPai)
    out.push(
      tool(
        "notify",
        "Tell the user something through pai's chat — only what they would act on or want to know today, in one line, the conclusion first; routine progress stays in your own chat (log). urgent: now with sound, even at night (minutes to act). normal: now, silent; held in quiet hours. digest: in the next brief. log: only in your own chat.",
        { text: z.string().max(1500), priority: priority.optional() },
        guard((a: { text: string; priority?: asks.Priority }) => asks.notify(self, a.text, a.priority ?? "normal")),
      ),
      tool(
        "check_outbound",
        "Before an outbound action (send email, LinkedIn message, Telegram message as the user, calendar invite to someone else, post, pay, delete): the user's pin for that action type, if any. ask = get approval with ask_user first; auto = go ahead; none = your own judgment, ask when in doubt.",
        { action: z.string().describe("the action type in a few words: 'send email', 'linkedin message', 'calendar invite'"), summary: z.string().describe("what exactly, to whom") },
        guard((a: { action: string; summary: string }) => ({ pin: asks.pinFor(a.action) ?? "none" })),
      ),
    );
  out.push(
    tool(
      "request",
      "Ask for something another agent might do, by need, not by name: 'review in the user's voice', 'check calendar availability', 'is this person already a candidate?'. pai routes it; with reply_to_me (default) the answer arrives as a new message.",
      { need: z.string().describe("the kind of help, generic and short so the same need finds the same helper next time ('rewrite in the user's voice', not 'rewrite my reply to Anna'); the specifics go in payload"), payload: z.string().describe("everything the other side needs: the draft, the dates, the name"), reply_to_me: z.boolean().optional() },
      guard((a: { need: string; payload: string; reply_to_me?: boolean }) => {
        const r = requests.create(self, a.need, a.payload, a.reply_to_me ?? true);
        return { request: r.id, routed: r.handler ?? "pai decides", note: "End your turn if you need the answer to go on; it arrives as a message." };
      }),
    ),
  );

  // ---- agents ----------------------------------------------------------------
  if (isPai || role === "standing") {
    out.push(
      tool(
        isPai ? "create_agent" : "spawn_subagent",
        isPai
          ? "Create an agent. standing: owns an area (more than one task or a routine). sub: one bounded job, reports once and closes. service: answers requests (no tasks). The brief is its CLAUDE.md: goal, context, voice, rules, what done means. task is the first job, sent right away."
          : "Start a sub-agent for one bounded job ('screen these 12 profiles'). It gets at most your tools, reports back to you once and closes.",
        {
          name: z.string().describe("short display name: 'Hiring', 'Job search', 'Screener'"),
          ...(isPai ? { kind: z.enum(["standing", "sub", "service"]) } : {}),
          brief: z.string(),
          task: z.string().optional().describe("the first job"),
          tools: z.array(z.string()).optional().describe("What it may use, by capability: gmail, linkedin, telegram, notion, drive, browser, calendar, balance. Omit for all of yours."),
          model: model.optional(),
          project: z.string().optional().describe("a repo slug: a coding agent working there"),
          turns_per_day: z.number().optional(),
          turn_minutes: z.number().optional().describe("how long one turn may run (default 20); up to 90 for a long read-through"),
          task_id: z.number().optional(),
        },
        guard((a: { name: string; kind?: "standing" | "sub" | "service"; brief: string; task?: string; tools?: string[]; model?: string; project?: string; turns_per_day?: number; turn_minutes?: number; task_id?: number }) => {
          const created = agents.create(
            { name: a.name, kind: isPai ? (a.kind ?? "standing") : "sub", parent: isPai && a.kind !== "sub" ? agents.PAI : self, brief: a.brief, tools: a.tools, model: a.model, project: a.project, budget: a.turns_per_day || a.turn_minutes ? { ...(a.turns_per_day ? { turnsPerDay: a.turns_per_day } : {}), ...(a.turn_minutes ? { turnMinutes: Math.min(90, a.turn_minutes) } : {}) } : undefined },
            self,
          );
          if (a.task?.trim()) agents.message(created.slug, a.task, { from: self, kind: "delegate", taskId: a.task_id });
          if (a.task_id) tasks.update(a.task_id, { owner: created.slug, status: "active" });
          return agentSummary(agents.get(created.slug)!);
        }),
      ),
      tool(
        "message_agent",
        isPai ? "Hand work or a follow-up to an agent. It wakes with this as its next turn and reports back." : "Send one of your sub-agents a follow-up.",
        { agent: z.string(), text: z.string(), task_id: z.number().optional().describe("the task this is about: the message and the report go into that task's thread") },
        guard((a: { agent: string; text: string; task_id?: number }) => {
          const target = mine(self, a.agent);
          agents.message(target.slug, a.text, { from: self, kind: "delegate", taskId: a.task_id });
          return { sent: true, agent: target.slug, status: agents.get(target.slug)!.status };
        }),
      ),
      tool(
        "list_agents",
        isPai ? "Your staff: every agent, its status, open tasks and spend today." : "Your sub-agents.",
        { include_closed: z.boolean().optional() },
        guard((a: { include_closed?: boolean }) => {
          const open = tasks.openCounts();
          return agents
            .list({ closed: a.include_closed, parent: isPai ? undefined : self })
            .filter((x) => x.kind !== "orchestrator")
            .map((x) => ({ ...agentSummary(x), openTasks: open[x.slug] ?? 0 }));
        }),
      ),
      tool(
        "agent_log",
        "What was said to and by an agent (its chat): briefs, reports, requests, asks, events, newest last.",
        { agent: z.string(), limit: z.number().optional() },
        guard((a: { agent: string; limit?: number }) => {
          mine(self, a.agent);
          return messages.list({ agent: a.agent, limit: a.limit ?? 30 }).map((m) => ({ id: m.id, at: new Date(m.createdAt).toISOString().slice(0, 16), from: m.from, to: m.to, kind: m.kind, body: m.body.slice(0, 600) }));
        }),
      ),
      tool(
        "close_agent",
        "Close an agent whose work is done: its folder is archived, a line goes into the journal, its sub-agents close too.",
        { agent: z.string(), summary: z.string().optional() },
        guard((a: { agent: string; summary?: string }) => agentSummary(agents.close(mine(self, a.agent).slug, a.summary ?? ""))),
      ),
    );
  }
  if (isPai)
    out.push(
      tool(
        "configure_agent",
        "Change an agent: brief (rewrites its CLAUDE.md), tools, model, daily turn budget, minutes per turn, its notices' priority (-2 quieter … +2 louder), or where it sits in the tree (parent — a standing agent still reports to you wherever it sits).",
        { agent: z.string(), name: z.string().optional(), brief: z.string().optional(), parent: z.string().optional(), tools: z.array(z.string()).nullable().optional(), model: model.nullable().optional(), turns_per_day: z.number().optional(), turn_minutes: z.number().optional(), priority: z.number().optional() },
        guard((a: { agent: string; name?: string; brief?: string; parent?: string; tools?: string[] | null; model?: string | null; turns_per_day?: number; turn_minutes?: number; priority?: number }) =>
          agentSummary(
            agents.configure(a.agent, {
              name: a.name,
              brief: a.brief,
              parent: a.parent,
              tools: a.tools,
              model: a.model,
              priority: a.priority,
              budget: a.turns_per_day || a.turn_minutes ? { ...(a.turns_per_day ? { turnsPerDay: a.turns_per_day } : {}), ...(a.turn_minutes ? { turnMinutes: a.turn_minutes } : {}) } : undefined,
            }),
          ),
        ),
      ),
      tool(
        "forward_request",
        "Route an agent's request to the agent that can do it. The route is remembered: the same need goes there by itself next time (remember false for a one-off).",
        { request: z.number(), agent: z.string(), remember: z.boolean().optional() },
        guard((a: { request: number; agent: string; remember?: boolean }) => requests.forward(a.request, a.agent, a.remember ?? true)),
      ),
      tool(
        "respond_request",
        "Answer an agent's request yourself; the answer goes back to whoever asked. For an outbound approval: 'approved' with the final text, or what to change.",
        { request: z.number(), text: z.string() },
        guard((a: { request: number; text: string }) => requests.respond(a.request, a.text)),
      ),
      tool(
        "list_requests",
        "Requests between agents, newest first, and the routes learned so far.",
        { open_only: z.boolean().optional() },
        guard((a: { open_only?: boolean }) => ({ requests: requests.list({ status: a.open_only ? "open" : undefined, limit: 30 }), routes: requests.routes() })),
      ),
      tool(
        "answer_ask",
        "The user's message answers an open ask: pass it on to the agent that asked.",
        { ask: z.number(), answer: z.string() },
        guard((a: { ask: number; answer: string }) => asks.answer(a.ask, a.answer, "pai")),
      ),
      tool(
        "open_asks",
        "What the agents are waiting on the user for (\"what do you need from me?\").",
        {},
        guard(() => asks.open().map((a) => ({ id: a.id, from: agents.breadcrumb(a.agent), question: a.question, options: a.options, since: new Date(a.createdAt).toISOString().slice(0, 16), blocking: a.blocking }))),
      ),
      tool(
        "drop_ask",
        "Withdraw an open ask the user will not answer (it no longer matters).",
        { ask: z.number() },
        guard((a: { ask: number }) => ({ dropped: asks.drop(a.ask) })),
      ),
      tool(
        "set_pin",
        "The user's standing rule for an outbound action type: always ask, always auto, or clear it (mode null). Overrides any agent's own judgment.",
        { action: z.string().describe("'send email', 'linkedin message', 'calendar hold on own calendar', 'archive newsletter'"), mode: z.enum(["ask", "auto"]).nullable() },
        guard((a: { action: string; mode: asks.PinMode | null }) => asks.pin(a.action, a.mode)),
      ),
      tool(
        "mute",
        "The user does not want to hear about something: incoming items and notices matching these words are dropped by triage from now on. List with mutes; remove by id.",
        { pattern: z.string().optional(), source: z.string().optional().describe("gmail, telegram, linkedin; empty = any"), remove: z.number().optional() },
        guard((a: { pattern?: string; source?: string; remove?: number }) => {
          if (a.remove) return { removed: asks.unmute(a.remove), mutes: asks.mutes() };
          if (a.pattern) asks.mute(a.pattern, a.source ?? "");
          return asks.mutes();
        }),
      ),
      tool(
        "set_quiet_hours",
        "When notices are held (urgent ones still go through; agents keep working). HH:MM-HH:MM in the user's time zone. Takes effect after the daemon's next restart.",
        { range: z.string().regex(/^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/) },
        guard(async (a: { range: string }) => ({ ...(await settings.write({ PAI_QUIET_HOURS: a.range })), timezone: config.timezone })),
      ),
    );

  // ---- routines --------------------------------------------------------------
  if (role !== "service") {
    out.push(
      tool(
        "routine_add",
        "Something that recurs: a schedule (cron, five fields, in the user's time zone: '0 8 * * *' = daily 08:00, '*/15 * * * *') or an event (gmail.new, linkedin.message, telegram.dm, calendar.upcoming, task.updated…), an optional check in code, and the message the agent is woken with ({field} reads the event). The model only runs when the check passes.",
        {
          name: z.string(),
          schedule: z.string().optional(),
          event: z.string().optional(),
          check: z
            .object({ contains: z.array(z.string()).optional(), excludes: z.array(z.string()).optional(), not_muted: z.boolean().optional(), outside_attendee: z.boolean().optional(), matches_open_task: z.string().optional().describe("an event field whose value must appear in one of the agent's open tasks") })
            .optional(),
          message: z.string().describe("what the agent is told when it fires"),
          ...(isPai ? { agent: z.string().optional().describe("the agent woken; default you") } : {}),
        },
        guard((a: { name: string; schedule?: string; event?: string; check?: automations.Check; message: string; agent?: string }) => {
          const agent = isPai ? (a.agent ?? agents.PAI) : self;
          if (isPai && agent !== agents.PAI && !agents.get(agent)) throw new Error(`no agent ${agent}`);
          return automations.create({ name: a.name, schedule: a.schedule, event: a.event ?? "", check: a.check, action: agent === agents.PAI ? "turn" : "wake", agent, template: a.message, owner: self });
        }),
      ),
      tool(
        "routine_list",
        isPai ? "Every routine: what fires it, what it checks, whom it wakes." : "Your routines.",
        {},
        guard(() => automations.all().filter((r) => isPai || r.owner === self || r.agent === self)),
      ),
      tool(
        "routine_update",
        "Change or pause a routine (enabled false).",
        { id: z.number(), name: z.string().optional(), schedule: z.string().optional(), event: z.string().optional(), message: z.string().optional(), enabled: z.boolean().optional() },
        guard((a: { id: number; name?: string; schedule?: string; event?: string; message?: string; enabled?: boolean }) => {
          const r = automations.all().find((x) => x.id === a.id);
          if (!r || (!isPai && r.owner !== self && r.agent !== self)) throw new Error(`no routine ${a.id} of yours`);
          return automations.update(a.id, { name: a.name, schedule: a.schedule, event: a.event, template: a.message, enabled: a.enabled });
        }),
      ),
      tool(
        "routine_remove",
        "Delete a routine.",
        { id: z.number() },
        guard((a: { id: number }) => {
          const r = automations.all().find((x) => x.id === a.id);
          if (!r || (!isPai && r.owner !== self && r.agent !== self)) throw new Error(`no routine ${a.id} of yours`);
          return { removed: automations.remove(a.id) };
        }),
      ),
    );
  }
  return out;
}
