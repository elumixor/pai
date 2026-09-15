export interface SessionSummary {
  readonly sessionId: string;
  readonly shortId: string;
  /** `main`, `task`, `code` — or `claude`, a conversation on disk the daemon has not run yet. */
  readonly kind: string;
  readonly title: string;
  readonly state: string;
  readonly cwd?: string;
  readonly project?: string;
  readonly waiting?: boolean;
  readonly lastTool?: string;
  readonly turns?: number;
  readonly costUsd?: number;
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
  readonly error?: string;
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

export interface Memory {
  readonly name: string;
  readonly type: string;
  readonly description: string;
  readonly body: string;
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
    readonly telegram: boolean;
    readonly idleShutdownMinutes: number;
  };
  readonly counts: { readonly projects: number; readonly memories: number };
}

export interface PaiEvent {
  readonly kind: string;
  readonly sessionId?: string;
  readonly ts: number;
  readonly payload: Record<string, unknown>;
}
