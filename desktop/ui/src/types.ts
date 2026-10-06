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
  };
  readonly createdAt: number;
}

export type TaskStatus = "inbox" | "active" | "waiting_user" | "waiting_other" | "scheduled" | "done" | "dropped";

export interface TaskItem {
  readonly id: number;
  readonly title: string;
  readonly owner: string;
  readonly status: TaskStatus;
  readonly nextAction: string;
  readonly due: string | null;
  readonly source: string | null;
  readonly updatedAt?: number;
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
