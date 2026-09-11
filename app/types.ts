export interface SessionSummary {
  readonly id: string;
  readonly shortId: string;
  readonly kind: string;
  readonly title: string;
  readonly state: string;
  readonly project?: string;
  readonly waiting?: boolean;
  readonly lastTool?: string;
  readonly turns?: number;
  readonly costUsd?: number;
}

export interface TerminalSummary {
  readonly id: string;
  readonly cwd: string;
  readonly project?: string;
  readonly alive: boolean;
}

export interface ProjectSummary {
  readonly slug: string;
  readonly path: string;
  readonly summary: string;
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
  readonly host: { readonly hostname: string; readonly platform: string; readonly baseUrl?: string; readonly api: string };
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
