/** The daemon's shapes as the client reads them over HTTP. */
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

export interface Question {
  readonly question: string;
  readonly header: string;
  readonly options: readonly { readonly label: string; readonly description: string }[];
  readonly multiSelect: boolean;
}

export interface PaiEvent {
  readonly kind: string;
  readonly sessionId?: string;
  readonly ts: number;
  readonly payload: Record<string, unknown>;
}

// ---- the staff: pai, its agents, the message log between them, tasks, asks, routines -----

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type AgentKind = "orchestrator" | "standing" | "sub" | "service";

export type AgentStatus = "idle" | "queued" | "working" | "waiting" | "closed";

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
}

export type MessageKind = "chat" | "delegate" | "report" | "request" | "response" | "ask" | "answer" | "notice" | "event";

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

export interface Need {
  readonly kind: "ask" | "question" | "task" | "draft";
  readonly draftId?: number;
  readonly draft?: NonNullable<LogMessage["meta"]["draft"]>;
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

export type ConnectorState = "signed_in" | "signed_out" | "broken";

/** One connector module as `GET /connectors` lists it. */
export interface Connector {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly status: { readonly state: ConnectorState; readonly detail?: string; readonly fix?: { readonly label: string; readonly url: string } };
  readonly events: readonly { readonly kind: string; readonly description: string }[];
  readonly tools: readonly string[];
  readonly canSend: boolean;
}

/** What the daemon tells a browser before it signs in. */
export interface AuthConfig {
  readonly clerkPublishableKey: string | null;
  readonly keepUrl: string | null;
}

/** A picture or file going out with a message, as the API takes it. */
export interface Upload {
  readonly media_type: string;
  readonly data: string;
  readonly name?: string;
}
