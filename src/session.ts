import { randomUUID } from "node:crypto";
import { query, startup, type Options, type Query, type SDKMessage, type SDKUserMessage, type WarmQuery } from "@anthropic-ai/claude-agent-sdk";
import { config } from "./config.ts";
import { db, now } from "./db.ts";
import { bus } from "./bus.ts";
import { logger } from "./log.ts";
import { paiTools, type SessionRef } from "./tools.ts";
import { browserMcp } from "./browser.ts";
import { instructionsFor } from "./prompts.ts";
import { enabled as tgUserEnabled, telegramUserTools } from "./tg-user.ts";

/** Subprocesses spawned and initialised ahead of time, keyed by kind. Only kinds with a fixed cwd can be warmed. */
interface Warm {
  id: string;
  ref: SessionRef;
  ready: Promise<WarmQuery>;
}
const warm = new Map<SessionKind, Warm>();

function build(kind: SessionKind, cwd: string, ref: SessionRef): Options {
  return {
    cwd,
    model: kind === "main" ? config.models.main : config.models.task,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    // Project settings only: the user's global hooks and plugins are for their
    // terminal sessions, not for the assistant. claude.ai connectors still load.
    settingSources: ["project"],
    additionalDirectories: kind === "code" ? [config.workspace] : [],
    systemPrompt: { type: "preset", preset: "claude_code", append: instructionsFor(kind) },
    mcpServers: {
      pai: paiTools(kind, ref),
      ...(tgUserEnabled() ? { tg: telegramUserTools() } : {}),
      playwright: browserMcp(),
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
export function prewarm(kind: "main" | "task") {
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
export function rewarm(kind: "main" | "task") {
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

export type SessionKind = "main" | "task" | "code";
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
  /** Resume an existing on-disk session instead of starting a fresh one. */
  resume?: string;
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
  cardId: number | null = null;
  state: SessionState = "starting";
  costUsd = 0;
  turns = 0;
  lastTool = "";

  private q?: Query;
  private inbox: SDKUserMessage[] = [];
  private wake?: () => void;
  private closed = false;
  private warm?: Warm;
  private turnText: string[] = [];
  private streamText = "";
  /** True between a user turn being sent and its result; injected context produces results too, which are not turns. */
  private activeTurn = false;
  pending?: PendingQuestion;

  constructor(opts: SessionOptions) {
    // A fresh session of a warmable kind adopts the pre-spawned process and its id.
    this.warm = !opts.resume && opts.cwd === config.workspace ? takeWarm(opts.kind) : undefined;
    this.id = opts.resume ?? this.warm?.id ?? randomUUID();
    this.shortId = this.id.slice(0, 6);
    this.kind = opts.kind;
    this.cwd = opts.cwd;
    this.project = opts.project;
    this.title = opts.title;
    this.threadId = opts.threadId ?? null;
    if (opts.resume) {
      const row = db.query("SELECT card_id, cost_usd, turns FROM sessions WHERE session_id = ?").get(this.id) as
        | { card_id: number | null; cost_usd: number; turns: number }
        | undefined;
      this.cardId = row?.card_id ?? null;
      this.costUsd = row?.cost_usd ?? 0;
      this.turns = row?.turns ?? 0;
    }
    this.start(opts.resume !== undefined);
  }

  private start(resume: boolean) {
    const ref: SessionRef = { session: this };
    const options = build(this.kind, this.cwd, ref);
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
      log.error(`${this.shortId} query failed`, (err as Error).message);
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
          this.state = "busy";
          this.persist();
        }
        if (m.subtype === "status" && m.status === "compacting") bus.emitEvent("session.status", { status: "compacting" }, this.id);
        break;

      case "stream_event": {
        const e = m.event as { type: string; delta?: { type: string; text?: string } };
        if (e.type === "content_block_delta" && e.delta?.type === "text_delta" && e.delta.text) {
          this.streamText += e.delta.text;
          bus.emitEvent("session.delta", { text: this.streamText }, this.id);
        }
        if (e.type === "message_stop" || e.type === "content_block_start") {
          // A new block or message begins: the previous text block is complete.
          if (e.type === "content_block_start" && this.streamText) this.streamText += "\n\n";
        }
        break;
      }

      case "assistant": {
        for (const block of m.message.content as Record<string, any>[]) {
          if (block.type === "text" && block.text) {
            this.turnText.push(block.text);
            bus.emitEvent("session.text", { text: block.text }, this.id);
          } else if (block.type === "tool_use") {
            this.lastTool = summarizeTool(block.name, block.input);
            bus.emitEvent("session.tool", { name: block.name, summary: this.lastTool }, this.id);
          }
        }
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
        if (!this.activeTurn && !text) {
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
    this.activeTurn = true;
    this.wake?.();
    if (this.state === "idle") {
      this.state = "busy";
      this.persist();
    }
    bus.emitEvent("session.input", { text }, this.id);
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

  private touch() {
    db.prepare("UPDATE sessions SET last_activity = ? WHERE session_id = ?").run(now(), this.id);
  }

  persist() {
    db.prepare(
      `INSERT INTO sessions (session_id, short_id, kind, title, cwd, project, thread_id, card_id, state, started_at, last_activity, cost_usd, turns)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET state=excluded.state, title=excluded.title, thread_id=excluded.thread_id,
         card_id=excluded.card_id, last_activity=excluded.last_activity, cost_usd=excluded.cost_usd, turns=excluded.turns`,
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
      state: this.state,
      costUsd: this.costUsd,
      turns: this.turns,
      lastTool: this.lastTool,
      queued: this.inbox.length,
      waiting: Boolean(this.pending),
    };
  }

  toJSON() {
    return this.summary();
  }
}

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
