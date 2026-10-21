export interface SessionSummary {
  readonly sessionId: string;
  readonly shortId: string;
  /** `chat`, `code` — or `claude`, a conversation on disk the daemon has not run yet. */
  readonly kind: string;
  readonly title: string;
  readonly state: string;
  readonly cwd?: string;
  readonly project?: string;
  readonly waiting?: boolean;
  readonly lastTool?: string;
  /** The tool calls of the turn in progress. */
  readonly recentTools?: readonly string[];
  /** The session that started this one, if it was not the user. */
  readonly parent?: string | null;
  readonly turns?: number;
  readonly costUsd?: number;
  /** The model that answered last, as the API names it. */
  readonly model?: string | null;
  /** The model and effort asked for, when they were. */
  readonly modelPref?: string | null;
  readonly effort?: Effort | null;
  readonly lastActivity?: number | string;
}

/** A conversation found in `~/.claude/projects`, terminal ones included. */
export interface DiskSession {
  readonly sessionId: string;
  readonly cwd: string;
  readonly title: string;
  readonly lastActivity: string;
}

export interface TerminalSummary {
  readonly id: string;
  readonly cwd: string;
  readonly project?: string;
  readonly process?: string;
  readonly alive: boolean;
  readonly startedAt?: string;
}

export interface ProjectSummary {
  readonly slug: string;
  readonly path: string;
  readonly summary: string;
  readonly kind?: "repo" | "context";
  readonly repo?: string;
}

export interface UsageWindow {
  readonly name: string;
  readonly percent: number;
  readonly resetsAt?: string;
  readonly length: number;
}

export interface Usage {
  readonly windows: readonly UsageWindow[];
  readonly costUsd: number;
  readonly fetchedAt?: string;
  /** The machine whose login answered, when it was not this one. */
  readonly via?: string;
  readonly error?: string;
  /** No machine has shared a Claude login the limits can be read with. */
  readonly needsLogin?: boolean;
}

/** One Mac's file sync against the box, as its menu bar app last reported it (`GET /sync`). */
export interface SyncReport {
  readonly machine: string;
  readonly state: "synced" | "syncing" | "conflicts" | "paused" | "connecting" | "off";
  readonly conflicts: number;
  readonly text: string;
  readonly at: string;
}

export interface ModuleSetting {
  readonly key: string;
  readonly label: string;
  readonly hint?: string;
  readonly secret?: boolean;
  readonly type?: "text" | "toggle" | "number";
  readonly value: string;
}

export interface ModuleInfo {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly kind: "channel" | "tools" | "source" | "service";
  readonly enabled: boolean;
  readonly status: Record<string, unknown>;
  readonly tools?: { readonly server: string; readonly names: readonly string[]; readonly kinds: readonly string[] };
  readonly prompt?: { readonly text: string; readonly kinds: readonly string[] };
  readonly events?: readonly { readonly kind: string; readonly description: string }[];
  readonly settings?: readonly ModuleSetting[];
  readonly accounts?: {
    readonly items: readonly { readonly label: string; readonly detail: string }[];
    readonly connectPath: string;
    readonly removePath: string;
    readonly hint: string;
  };
  readonly live: boolean;
  /** A module from its own repository with a page of its own: its path under the daemon. */
  readonly ui?: string;
  readonly external?: boolean;
}

export interface Automation {
  readonly id: number;
  readonly name: string;
  readonly event: string;
  readonly filter: string;
  readonly action: "notify" | "turn" | "task";
  readonly project: string;
  readonly template: string;
  readonly enabled: boolean;
  readonly runs: number;
  readonly lastRun: number | null;
}

export interface ContextItem {
  readonly kind: "instruction" | "memory" | "skill" | "tool";
  readonly name: string;
  readonly description: string;
  readonly source: string;
  readonly editable: boolean;
  readonly surfaces: readonly string[];
  readonly project?: string;
  readonly body?: string;
}

export interface SlashCommand {
  readonly name: string;
  readonly description: string;
  readonly argumentHint: string;
}

export interface Diagnostic {
  readonly line: number;
  readonly column: number;
  readonly message: string;
  readonly severity: "error" | "warning";
  readonly code: string;
}

export interface Question {
  readonly question: string;
  readonly header: string;
  readonly options: readonly { readonly label: string; readonly description: string }[];
  readonly multiSelect: boolean;
}

export interface Entry {
  readonly name: string;
  readonly path: string;
  readonly directory: boolean;
  readonly size: number;
  readonly modified: string;
}

export interface Status {
  readonly pid: number;
  readonly uptime: number;
  readonly version: string;
  readonly host: { readonly hostname: string; readonly platform: string; readonly baseUrl?: string; readonly api: string; readonly publicUrl?: string };
  readonly editor: { readonly enabled: boolean; readonly url?: string; readonly running: boolean };
  readonly settings: {
    readonly workspace: string;
    readonly devRoot: string;
    readonly models: { readonly main: string; readonly task: string };
    readonly updateChannel: string;
    readonly autoUpdate: boolean;
    readonly idleShutdownMinutes: number;
  };
  readonly counts: { readonly projects: number };
}

export interface PaiEvent {
  readonly kind: string;
  readonly sessionId?: string;
  readonly ts: number;
  readonly payload: Record<string, unknown>;
}

// ---- the staff: pai, its agents, the message log between them, tasks, asks, routines -----

/** How hard a session thinks; the SDK's levels. */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type AgentKind = "orchestrator" | "standing" | "sub" | "service";
export type AgentStatus = "idle" | "queued" | "working" | "waiting" | "closed";

/** One agent as `GET /agents` lists it; `agent.changed` carries the same row without the tree fields. */
export interface Agent {
  readonly slug: string;
  readonly name: string;
  readonly kind: AgentKind;
  readonly parent: string | null;
  readonly brief: string;
  readonly status: AgentStatus;
  readonly model?: string | null;
  readonly tools?: readonly string[] | null;
  readonly turnsToday: number;
  readonly costUsd: number;
  readonly lastActive?: number | null;
  readonly depth?: number;
  /** Names from pai down: "pai › Hiring › Screener". */
  readonly breadcrumb?: string;
  readonly openTasks?: number;
  readonly queued?: number;
  /** Capabilities it was given that no MCP server here provides: tools it will not have. */
  readonly unresolvedTools?: readonly string[];
  readonly effort?: Effort | null;
  readonly project?: string | null;
  /** Reports it receives from the agents under it go on to its own parent too. */
  readonly bubble?: boolean;
  readonly budget?: { readonly turnsPerDay: number; readonly turnMinutes: number };
  readonly createdAt?: number;
  readonly closedAt?: number | null;
  /** Plain threads it started (pai's: terminals and chats too), live or active within a week. */
  readonly threads?: readonly AgentThread[];
}

export interface AgentThread {
  readonly sessionId: string;
  readonly shortId: string;
  readonly title: string;
  readonly project: string | null;
  readonly cwd?: string | null;
  readonly kind?: string;
  readonly state: string;
  readonly startedAt?: number;
  readonly lastActivity: number;
  readonly costUsd?: number;
  readonly turns?: number;
  readonly model?: string | null;
  readonly modelPref?: string | null;
  readonly effort?: Effort | null;
  /** Where it was started: `agent` (by the agent it is listed under), `general` (the client's detached box), `cli`, `terminal`, `phone`, `builder`, `routine`. */
  readonly origin?: string;
}

/** `GET /agents/<slug>/instructions`: its own files (CLAUDE.md and what that imports) and what is appended to Claude Code's prompt. */
export interface AgentInstructions {
  readonly folder: string;
  readonly files: readonly { readonly name: string; readonly text: string }[];
  readonly system: string;
}

export type MessageKind = "chat" | "delegate" | "report" | "request" | "response" | "ask" | "answer" | "notice" | "event";

/** One row of the message log: who said what to whom. `from`/`to` are `user`, `pai`, a slug, `routine:<id>`, `watcher:<source>`. */
export interface LogMessage {
  readonly id: number;
  readonly from: string;
  readonly to: string;
  readonly kind: MessageKind;
  readonly body: string;
  readonly taskId: number | null;
  readonly meta: {
    readonly event?: string;
    readonly askId?: number;
    readonly options?: readonly string[];
    readonly breadcrumb?: string;
    readonly priority?: string;
    readonly agent?: string;
    readonly source?: string;
    readonly link?: string;
    /** On pai's own replies: `user`, `system` or `silent` — what the turn answered. */
    readonly origin?: string;
    readonly freeText?: boolean;
    /** A one-line gist of a long message, written by the daemon's summariser. */
    readonly tldr?: string;
    /** Pictures that came with it: attachment names, or urls an `<img>` loads directly. */
    readonly images?: readonly string[];
    /** Files that came with it: the kept name, his name for it, and how big it is. */
    readonly files?: readonly { readonly file: string; readonly name: string; readonly size: number; readonly media_type: string }[];
    /** A draft he approves on its own card: the fields as they stand, and what became of it. */
    readonly draftId?: number;
    readonly draft?: {
      readonly channel: "email" | "telegram" | "whatsapp" | "linkedin" | "post";
      readonly fields: { readonly to?: string; readonly cc?: string; readonly subject?: string; readonly body: string; readonly account?: string };
      readonly status: "pending" | "sending" | "sent" | "failed" | "dropped";
      readonly state?: "verified" | "unverified" | "not_sent" | null;
      readonly note?: string;
    };
    /** A map pin, drawn as a place card. */
    readonly place?: { readonly latitude: number; readonly longitude: number; readonly title?: string; readonly address?: string };
    /** A six-word line for the row, written once by a small model. */
    readonly headline?: string;
    /** An answer's reply to the ask it answers: who asked, the ask's first line, and its row. */
    readonly quote?: { readonly from: string; readonly excerpt: string; readonly messageId?: number; readonly at?: number };
  };
  readonly createdAt: number;
}

export type TaskStatus = "inbox" | "active" | "waiting_user" | "waiting_other" | "scheduled" | "done" | "dropped";

export interface TaskItem {
  readonly id: number;
  readonly title: string;
  readonly parentId?: number | null;
  readonly owner: string;
  readonly status: TaskStatus;
  readonly nextAction: string;
  readonly due: string | null;
  readonly source: string | null;
  readonly notes?: string;
  readonly createdAt?: number;
  readonly updatedAt?: number;
}

/** One thing that waits on the user, as `GET /needs` lists them: an agent's ask, a session's question, a task waiting on them. */
export interface Need {
  readonly kind: "ask" | "question" | "task";
  readonly id: string;
  readonly askId?: number;
  readonly taskId?: number;
  readonly session?: string;
  readonly agent: string | null;
  readonly from: string;
  readonly question: string;
  readonly options: readonly string[];
  readonly freeText: boolean;
  readonly priority: string;
  readonly link?: string;
  readonly createdAt: number;
}

export interface Ask {
  readonly id: number;
  readonly agent: string;
  readonly question: string;
  readonly options: readonly string[];
  readonly freeText: boolean;
  readonly priority: string;
  readonly blocking: boolean;
  readonly context?: string;
  readonly status?: "open" | "answered" | "dropped";
  readonly createdAt: number;
}

export interface Routine {
  readonly id: number;
  readonly name: string;
  readonly event: string;
  readonly schedule: string;
  readonly action: string;
  readonly agent: string;
  readonly enabled: boolean;
  readonly runs: number;
  readonly lastRun: number | null;
  readonly owner: string;
}

/** One outward tool call as `GET /audit` lists them: a send, a write, a click in a signed-in site. */
export interface AuditEntry {
  readonly toolUseId: string;
  readonly sessionId: string;
  readonly agent: string | null;
  readonly tool: string;
  readonly summary: string;
  readonly input: string;
  readonly result: string | null;
  /** null while the call has not answered. */
  readonly ok: boolean | null;
  readonly ts: number;
}

/** One group in `GET /spend`: API list price beside what was actually paid, tokens and time. */
export interface SpendBucket {
  readonly key: string;
  readonly apiUsd: number;
  readonly realUsd: number;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly ms: number;
  readonly calls: number;
}

export interface SpendReport {
  readonly days: number;
  readonly plan: { readonly monthlyUsd: number; readonly periodUsd: number; readonly tier?: string };
  readonly credits: { readonly usedUsd: number; readonly monthlyUsd: number };
  readonly box?: { readonly periodUsd: number };
  readonly total: SpendBucket & { readonly savedUsd: number };
  readonly by: Record<"agent" | "project" | "model" | "source", SpendBucket[]>;
  readonly daily: SpendBucket[];
}
