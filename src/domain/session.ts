import { randomUUID } from "node:crypto";
import { query, startup, type Options, type Query, type SDKMessage, type SDKUserMessage, type SlashCommand, type WarmQuery } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../core/config.ts";
import { db, now } from "../core/db.ts";
import { bus } from "../core/bus.ts";
import { logger } from "../core/log.ts";
import { resultPreview } from "./transcript.ts";
import { paiTools, type SessionRef } from "./tools.ts";
import { browserMcp } from "./browser.ts";
import { instructionsFor } from "./prompts.ts";
import { gmailModule, gmailTools } from "../modules/gmail.ts";
import { mcpServers as externalMcpServers } from "../modules/external.ts";

/** Subprocesses spawned and initialised ahead of time, keyed by kind. Only kinds with a fixed cwd can be warmed. */
interface Warm {
  id: string;
  ref: SessionRef;
  ready: Promise<WarmQuery>;
}
const warm = new Map<SessionKind, Warm>();

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

function build(kind: SessionKind, cwd: string, ref: SessionRef, project?: string, prefs?: { model?: string | null; effort?: Effort | null }): Options {
  return {
    cwd,
    model: prefs?.model ?? (kind === "chat" ? config.models.main : config.models.task),
    ...(prefs?.effort ? { effort: prefs.effort } : {}),
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    // claude.ai connectors (Calendar, Balance, Notion, …) only load with the user's settings, so those
    // are in; the user's hooks are for their terminal sessions, not the assistant, and stay off.
    settingSources: ["user", "project"],
    settings: { disableAllHooks: true },
    // Discovered from .claude/skills under the project (and, for code sessions, the repo).
    // No global plugins: hooks like caveman's `~/.claude/.caveman-active` toggle assume one
    // interactive terminal and would race across pai's concurrent sessions.
    skills: "all",
    additionalDirectories: kind === "code" ? [config.workspace] : [],
    systemPrompt: { type: "preset", preset: "claude_code", append: instructionsFor(kind, project) },
    mcpServers: {
      pai: paiTools(kind, ref),
      playwright: browserMcp(),
      ...(gmailModule.enabled() && gmailModule.tools?.kinds.includes(kind) ? { gmail: gmailTools() } : {}),
      ...externalMcpServers(kind, ref),
    },
    canUseTool: async (tool, input) => {
      const s = ref.session;
      if (tool === "AskUserQuestion" && s) return s.ask(input as { questions: Question[] });
      return { behavior: "allow", updatedInput: input };
    },
    stderr: (data) => ref.session && log.debug(`${ref.session.shortId} stderr`, data.trim().slice(0, 300)),
    env: { ...process.env },
  };
}

/** Starts a subprocess for `kind` now so the next session of that kind opens without the spawn cost. */
export function prewarm(kind: "chat") {
  if (warm.has(kind)) return;
  const ref: SessionRef = {};
  const id = randomUUID();
  const options = { ...build(kind, config.workspace, ref), sessionId: id };
  const entry: Warm = { id, ref, ready: startup({ options }) };
  warm.set(kind, entry);
  entry.ready.then(
    () => log.debug(`warm ${kind} ready`),
    (err) => {
      log.warn(`prewarm ${kind} failed`, (err as Error).message);
      if (warm.get(kind) === entry) warm.delete(kind);
    },
  );
}

/** Takes the warm process for `kind`, if one exists. The caller owns it from here. */
function takeWarm(kind: SessionKind): Warm | undefined {
  const entry = warm.get(kind);
  if (entry) warm.delete(kind);
  return entry;
}

/** Drops the warm process so the next one is built with the current system prompt (memory index). */
export function rewarm(kind: "chat") {
  const entry = takeWarm(kind);
  if (!entry) return;
  void entry.ready.then((q) => q.close()).catch(() => {});
  prewarm(kind);
}

export function closeWarm() {
  for (const w of warm.values()) void w.ready.then((q) => q.close()).catch(() => {});
  warm.clear();
}

const log = logger("session");

/**
 * chat: a conversation with the assistant, in its workspace — every Telegram topic, every
 * `pai claude`, every thread the dashboard opens; none of them is special. code: a builder
 * thread in one of the user's repositories.
 */
export type SessionKind = "chat" | "code";

/** Rows from before the rename. */
export const asKind = (raw: string): SessionKind => (raw === "code" ? "code" : "chat");

/** Commands that only make sense at a terminal, or that pai handles itself. */
const HIDDEN_COMMANDS = new Set(["exit", "quit", "login", "logout", "statusline", "terminal-setup", "vim", "theme", "config", "ide", "resume", "clear", "doctor", "bug", "install-github-app", "mcp", "add-dir", "hooks", "permissions", "agents", "keybindings", "heapdump", "color", "auto-mode-setup", "workflow-launch-exec", "fast"]);

/** The title of a thread nobody has named yet. */
export const UNTITLED = "new thread";
export type SessionState = "starting" | "idle" | "busy" | "dead";

export interface Question {
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
}

export interface PendingQuestion {
  id: string;
  questions: Question[];
  /** Answers collected so far, by question index. The promise resolves once every question has one. */
  answers: Record<number, string>;
  resolve: (answer: { answers?: Record<string, string>; response?: string }) => void;
}

export interface SessionOptions {
  kind: SessionKind;
  title: string;
  cwd: string;
  project?: string;
  threadId?: number | null;
  /** The session that started this one, when it was not the user. Its results are relayed there. */
  parent?: string | null;
  /** Resume an existing on-disk session instead of starting a fresh one. */
  resume?: string;
  /** A model alias (sonnet, opus, fable, …) and reasoning effort for this session; the defaults otherwise. */
  model?: string | null;
  effort?: Effort | null;
}

/**
 * One Claude Code session driven through the Agent SDK in streaming-input mode.
 *
 * The process is disposable; the session is not. The transcript lives under
 * ~/.claude/projects, so a dead process is respawned with `resume` and keeps its
 * full context.
 */
export class Session {
  readonly id: string;
  readonly shortId: string;
  readonly kind: SessionKind;
  readonly cwd: string;
  readonly project?: string;
  title: string;
  threadId: number | null;
  readonly parent: string | null;
  cardId: number | null = null;
  state: SessionState = "starting";
  costUsd = 0;
  /** The model that answered last, as the API names it; the configured alias until the first reply. */
  model: string | null = null;
  /** What this session was told to run with; null means the daemon's default. */
  modelPref: string | null = null;
  effort: Effort | null = null;
  turns = 0;
  lastTool = "";
  /** The tool calls of the turn in progress, newest last, so a client can show what led here. */
  recentTools: string[] = [];

  private q?: Query;
  private inbox: SDKUserMessage[] = [];
  private wake?: () => void;
  private closed = false;
  private warm?: Warm;
  private turnText: string[] = [];
  /** The text block being streamed, and the turn's completed blocks before it. */
  private streamText = "";
  private turnStream = "";
  /** True between a user turn being sent and its result; injected context produces results too, which are not turns. */
  private activeTurn = false;
  pending?: PendingQuestion;
  /** The slash commands this session's process accepts, minus the ones bound to a terminal. */
  commands: SlashCommand[] = [];

  /** A user turn is out and its reply has not come back yet. */
  get awaitingReply() {
    return this.activeTurn;
  }

  constructor(opts: SessionOptions) {
    // A fresh session of a warmable kind adopts the pre-spawned process and its id.
    this.modelPref = opts.model ?? null;
    this.effort = opts.effort ?? null;
    // A warm process was built with the defaults; a session that wants otherwise starts its own.
    this.warm = !opts.resume && opts.cwd === config.workspace && !this.modelPref && !this.effort ? takeWarm(opts.kind) : undefined;
    this.id = opts.resume ?? this.warm?.id ?? randomUUID();
    this.shortId = this.id.slice(0, 6);
    this.kind = opts.kind;
    this.cwd = opts.cwd;
    this.project = opts.project;
    this.title = opts.title;
    this.threadId = opts.threadId ?? null;
    this.parent = opts.parent ?? null;
    if (opts.resume) {
      const row = db.query("SELECT card_id, cost_usd, turns, model, model_pref, effort FROM sessions WHERE session_id = ?").get(this.id) as
        | { card_id: number | null; cost_usd: number; turns: number; model: string | null; model_pref: string | null; effort: Effort | null }
        | undefined;
      this.cardId = row?.card_id ?? null;
      this.costUsd = row?.cost_usd ?? 0;
      this.turns = row?.turns ?? 0;
      this.model = row?.model ?? null;
      this.modelPref = opts.model ?? row?.model_pref ?? null;
      this.effort = opts.effort ?? row?.effort ?? null;
    }
    this.start(opts.resume !== undefined);
  }

  private resuming = false;

  private start(resume: boolean) {
    this.resuming = resume;
    const ref: SessionRef = { session: this };
    const options = build(this.kind, this.cwd, ref, this.project, { model: this.modelPref, effort: this.effort });
    options.title = this.title;
    if (resume) options.resume = this.id;
    else options.sessionId = this.id;

    this.persist();
    void (async () => {
      let q: Query | undefined;
      if (this.warm) {
        this.warm.ref.session = this;
        try {
          q = (await this.warm.ready).query(this.input());
          log.debug(`${this.shortId} took a warm ${this.kind} process`);
        } catch (err) {
          log.warn(`warm ${this.kind} unusable: ${(err as Error).message}`);
        }
      }
      this.q = q ?? query({ prompt: this.input(), options });
      // A control request, answered before the first turn — a resumed session sits idle until then.
      void this.loadCommands();
      bus.emitEvent(resume ? "session.resumed" : "session.started", this.summary(), this.id);
      if (!resume) this.inject(`You are session ${this.shortId} (${this.kind}), titled "${this.title}".`);
      await this.pump();
    })();
  }

  private async *input(): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      const next = this.inbox.shift();
      if (next) {
        yield next;
        continue;
      }
      await new Promise<void>((r) => (this.wake = r));
    }
  }

  private async pump() {
    try {
      for await (const m of this.q!) this.handle(m);
      this.die(0);
    } catch (err) {
      // The SDK wraps spawn failures, so the useful part (errno, the binary it tried) is
      // on the cause rather than the message.
      const detail = err as Error & { code?: string; cause?: unknown };
      // The transcript lives outside the repository, so a session restored from a database
      // that moved hosts has nothing to resume. Keep the session, drop the history.
      if (this.resuming && detail.message.includes("No conversation found")) {
        log.warn(`${this.shortId} has no transcript on this host; starting it fresh`);
        this.start(false);
        return;
      }
      log.error(
        `${this.shortId} query failed`,
        [detail.message, detail.code, detail.cause instanceof Error ? detail.cause.message : detail.cause]
          .filter(Boolean)
          .join(" | "),
      );
      bus.emitEvent("session.error", { message: (err as Error).message }, this.id);
      this.die(1);
    }
  }

  private die(code: number) {
    if (this.state === "dead") return;
    this.state = "dead";
    this.pending?.resolve({ response: "(session ended)" });
    this.pending = undefined;
    this.persist();
    bus.emitEvent("session.exit", { code }, this.id);
  }

  private handle(m: SDKMessage) {
    this.touch();
    switch (m.type) {
      case "system":
        if (m.subtype === "init" && this.state === "starting") {
          // A session revived with nothing to answer is idle, not busy: left busy it would
          // never be reaped and would look mid-turn to every restart after this one.
          this.state = this.activeTurn || this.inbox.length > 0 ? "busy" : "idle";
          this.persist();
          bus.emitEvent("session.ready", { state: this.state }, this.id);
        }
        if (m.subtype === "init") {
          if (m.model && m.model !== this.model) {
            this.model = m.model;
            this.persist();
          }
          void this.loadCommands(new Set(m.terminal_slash_commands ?? []));
        }
        if (m.subtype === "commands_changed") void this.loadCommands();
        if (m.subtype === "status" && m.status === "compacting") bus.emitEvent("session.status", { status: "compacting" }, this.id);
        // What a local slash command printed, and the loop's own notices (hook feedback, warnings).
        if (m.subtype === "local_command_output") bus.emitEvent("session.notice", { text: m.content, level: "output" }, this.id);
        if (m.subtype === "informational" && m.level !== "info") bus.emitEvent("session.notice", { text: m.content, level: m.level }, this.id);
        break;

      case "stream_event": {
        const e = m.event as { type: string; delta?: { type: string; text?: string } };
        if (e.type === "content_block_delta" && e.delta?.type === "text_delta" && e.delta.text) {
          this.streamText += e.delta.text;
          // `text` is the block being written, `turn` everything the turn has said so far: a
          // transcript view grows one entry per block, a draft shows the whole reply.
          bus.emitEvent("session.delta", { text: this.streamText, turn: this.turnStream + this.streamText }, this.id);
        }
        if (e.type === "content_block_start" && this.streamText) {
          // A new block begins: the previous text block is complete.
          this.turnStream += `${this.streamText}\n\n`;
          this.streamText = "";
        }
        break;
      }

      case "assistant": {
        // A subagent's messages carry the id of the Agent call that runs it; clients nest them under it.
        const parent = m.parent_tool_use_id ?? undefined;
        const model = (m.message as { model?: string }).model;
        if (model && !parent && model !== this.model) {
          this.model = model;
          this.persist();
          bus.emitEvent("session.model", { model }, this.id);
        }
        for (const block of m.message.content as Record<string, any>[]) {
          if (block.type === "text" && block.text) {
            if (parent) continue;
            this.turnText.push(block.text);
            bus.emitEvent("session.text", { text: block.text }, this.id);
          } else if (block.type === "tool_use") {
            this.lastTool = summarizeTool(block.name, block.input);
            this.recentTools = [...this.recentTools.slice(-(RECENT_TOOLS - 1)), this.lastTool];
            bus.emitEvent("session.tool", { id: block.id, name: block.name, summary: this.lastTool, parent }, this.id);
          }
        }
        break;
      }

      case "user": {
        // What a tool returned comes back as a user message; the clients show it under the call.
        const content = m.message.content;
        const parent = m.parent_tool_use_id ?? undefined;
        if (Array.isArray(content))
          for (const block of content as Record<string, any>[])
            if (block.type === "tool_result")
              bus.emitEvent("session.tool_result", { id: block.tool_use_id, result: resultPreview(block.content), parent }, this.id);
        break;
      }

      case "rate_limit_event":
        if (m.rate_limit_info.status !== "allowed")
          bus.emitEvent("rate_limit", m.rate_limit_info as unknown as Record<string, unknown>, this.id);
        break;

      case "result": {
        const text = this.turnText.join("\n\n").trim() || (m.subtype === "success" ? m.result : "");
        this.turnText = [];
        this.streamText = "";
        this.turnStream = "";
        this.recentTools = [];
        // A result with no model turn behind it (context injected with shouldQuery false) is
        // not the end of a turn a message is waiting for.
        if ((!this.activeTurn || m.num_turns === 0) && !text) {
          this.state = "idle";
          this.persist();
          break;
        }
        this.activeTurn = false;
        this.turns += 1;
        this.costUsd = m.total_cost_usd ?? this.costUsd;
        this.state = "idle";
        db.prepare("UPDATE sessions SET last_result = ? WHERE session_id = ?").run(text.slice(0, 4000), this.id);
        this.persist();
        bus.emitEvent(
          "session.turn_end",
          {
            text,
            isError: m.subtype !== "success" || Boolean(m.is_error),
            subtype: m.subtype,
            durationMs: m.duration_ms,
            costUsd: m.total_cost_usd,
            numTurns: m.num_turns,
          },
          this.id,
        );
        break;
      }
    }
  }

  /** Enqueue a user turn. The SDK queues it if a turn is already running. */
  send(text: string, opts: { images?: { media_type: string; data: string }[] } = {}) {
    if (this.state === "dead") throw new Error(`session ${this.shortId} is dead`);
    const content: any[] = [{ type: "text", text }];
    for (const img of opts.images ?? [])
      content.push({ type: "image", source: { type: "base64", media_type: img.media_type, data: img.data } });
    this.inbox.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null });
    // A thread started without a title is named after what was first said in it.
    if (this.title === UNTITLED && text.trim()) this.title = text.replace(/\s+/g, " ").trim().slice(0, 60);
    this.activeTurn = true;
    this.wake?.();
    if (this.state === "idle") {
      this.state = "busy";
      this.persist();
    }
    bus.emitEvent("session.input", { text }, this.id);
  }

  private terminalCommands = new Set<string>();

  /** Asks the process for its slash commands (skills, plugins, built-ins) and tells the clients. */
  private async loadCommands(terminal?: Set<string>) {
    if (terminal) this.terminalCommands = terminal;
    try {
      const all = (await this.q?.supportedCommands()) ?? [];
      this.commands = all.filter((c) => !this.terminalCommands.has(c.name) && !HIDDEN_COMMANDS.has(c.name) && !c.name.startsWith("__"));
      bus.emitEvent("session.commands", { count: this.commands.length }, this.id);
    } catch (err) {
      log.debug(`${this.shortId} commands: ${(err as Error).message}`);
    }
  }

  /** Append context to the transcript without spending a model turn on it. */
  inject(text: string) {
    if (this.state === "dead") return;
    this.inbox.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      shouldQuery: false,
    });
    this.wake?.();
  }

  ask(input: { questions: Question[] }) {
    return new Promise<{ behavior: "allow"; updatedInput: Record<string, unknown> }>((resolve) => {
      const id = randomUUID().slice(0, 8);
      this.pending = {
        id,
        questions: input.questions,
        answers: {},
        resolve: (answer) => {
          this.pending = undefined;
          bus.emitEvent("session.answer", { id, ...answer }, this.id);
          resolve({ behavior: "allow", updatedInput: { ...input, ...answer } });
        },
      };
      this.persist();
      bus.emitEvent("session.question", { id, questions: input.questions }, this.id);
    });
  }

  /** The index of the first question in the pending set that has no answer yet. */
  nextUnanswered(): number | undefined {
    const p = this.pending;
    if (!p) return undefined;
    const i = p.questions.findIndex((_, idx) => p.answers[idx] === undefined);
    return i === -1 ? undefined : i;
  }

  /**
   * Answers one question of the pending set, by index (a chosen option's label, or free text —
   * comma-joined labels for a multiSelect question). Resolves the underlying tool call once every
   * question in the set has an answer; a `AskUserQuestion` call can carry 1-4 of them.
   */
  answer(text: string, questionIndex = this.nextUnanswered() ?? 0) {
    const p = this.pending;
    if (!p) return false;
    const q = p.questions[questionIndex];
    if (!q) return false;
    p.answers[questionIndex] = text;
    if (Object.keys(p.answers).length < p.questions.length) {
      this.persist();
      return true;
    }
    const answers: Record<string, string> = {};
    p.questions.forEach((qq, i) => (answers[qq.question] = p.answers[i]!));
    p.resolve({ answers });
    return true;
  }

  async interrupt() {
    if (!this.q || this.state !== "busy") return false;
    await this.q.interrupt();
    return true;
  }

  kill() {
    this.closed = true;
    this.wake?.();
    try {
      this.q?.close();
    } catch {
      /* already gone */
    }
    this.die(0);
  }

  lastActivity = now();

  private touch() {
    this.lastActivity = now();
    db.prepare("UPDATE sessions SET last_activity = ? WHERE session_id = ?").run(this.lastActivity, this.id);
  }

  persist() {
    db.prepare(
      `INSERT INTO sessions (session_id, short_id, kind, title, cwd, project, thread_id, card_id, state, started_at, last_activity, cost_usd, turns, parent_id, model, model_pref, effort)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET state=excluded.state, title=excluded.title, thread_id=excluded.thread_id,
         card_id=excluded.card_id, last_activity=excluded.last_activity, cost_usd=excluded.cost_usd, turns=excluded.turns, model=excluded.model,
         model_pref=excluded.model_pref, effort=excluded.effort`,
    ).run(
      this.id,
      this.shortId,
      this.kind,
      this.title,
      this.cwd,
      this.project ?? null,
      this.threadId,
      this.cardId,
      this.state,
      now(),
      now(),
      this.costUsd,
      this.turns,
      this.parent,
      this.model,
      this.modelPref,
      this.effort,
    );
  }

  summary() {
    return {
      sessionId: this.id,
      shortId: this.shortId,
      kind: this.kind,
      title: this.title,
      project: this.project,
      cwd: this.cwd,
      threadId: this.threadId,
      parent: this.parent,
      state: this.state,
      lastActivity: this.lastActivity,
      costUsd: this.costUsd,
      turns: this.turns,
      model: this.model,
      modelPref: this.modelPref,
      effort: this.effort,
      lastTool: this.lastTool,
      recentTools: this.recentTools,
      queued: this.inbox.length,
      waiting: Boolean(this.pending),
    };
  }

  toJSON() {
    return this.summary();
  }
}

const RECENT_TOOLS = 5;

export function summarizeTool(name: string, input: Record<string, any> | undefined): string {
  const short = name.replace(/^mcp__/, "").replace(/__/g, ":");
  if (!input) return short;
  switch (name) {
    case "Bash":
      return `$ ${String(input.command ?? "").slice(0, 120)}`;
    case "Read":
    case "Edit":
    case "Write":
      return `${name} ${String(input.file_path ?? "").replace(process.env.HOME ?? "", "~")}`;
    case "Grep":
    case "Glob":
      return `${name} ${String(input.pattern ?? "")}`;
    case "WebSearch":
      return `search "${String(input.query ?? "").slice(0, 80)}"`;
    case "WebFetch":
      return `fetch ${String(input.url ?? "").slice(0, 100)}`;
    case "Agent":
    case "Task":
      return `agent: ${String(input.description ?? "")}`;
    case "AskUserQuestion":
      return "asking you";
    default: {
      const first = Object.values(input).find((v) => typeof v === "string") as string | undefined;
      return first ? `${short} ${first.slice(0, 80)}` : short;
    }
  }
}
