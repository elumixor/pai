/**
 * What an external module is written against. A module is a directory (its own repository,
 * named in `pai.config.ts`, installed under `modules/<name>/`) whose `index.ts` default-exports
 * a `PaiModule`. It runs inside the daemon and may give sessions tools and a prompt paragraph,
 * ship skills, answer `pai <name> …`, serve http under `/m/<name>/`, and keep something running.
 *
 * A module's `index.ts` default-exports a function of the `PaiSdk` — the runtime pieces a
 * module needs (the Agent SDK's `tool`, zod, the bus) handed over rather than imported, so a
 * module works from wherever its checkout is. Types come from this file, `import type`.
 */
import type { Database } from "bun:sqlite";
import type { SessionKind } from "../domain/session.ts";
import type { SessionRef } from "../domain/tools.ts";
import type { PaiEvent } from "../core/bus.ts";
import type { ModuleSetting } from "./types.ts";
import type { Project, ProjectSource } from "../domain/projects.ts";
import type { HeldThread, HeldThreads } from "../domain/held.ts";

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { recentEvents, waitFor } from "../core/bus.ts";

export type { SessionKind, SessionRef, PaiEvent, ModuleSetting, Project, ProjectSource, HeldThread, HeldThreads };

/** What a module's factory is handed: pai's runtime, so the module imports nothing from pai. */
export interface PaiSdk {
  readonly tool: typeof tool;
  readonly createSdkMcpServer: typeof createSdkMcpServer;
  readonly z: typeof z;
  readonly waitFor: typeof waitFor;
  readonly recentEvents: typeof recentEvents;
  readonly defineModule: (m: PaiModule) => PaiModule;
}

export const sdk: PaiSdk = { tool, createSdkMcpServer, z, waitFor, recentEvents, defineModule: (m) => m };

/** What `index.ts` default-exports: the module, or a function of the sdk that makes it. */
export type ModuleExport = PaiModule | ((pai: PaiSdk) => PaiModule);

export interface PaiConfig {
  /** name → where it lives: `github:owner/repo[#ref]`, a git url, or a path (absolute or relative to the repo). */
  readonly modules: Readonly<Record<string, string>>;
}

export interface Logger {
  debug(msg: string, ...rest: unknown[]): void;
  info(msg: string, ...rest: unknown[]): void;
  warn(msg: string, ...rest: unknown[]): void;
  error(msg: string, ...rest: unknown[]): void;
}

/** What a module is handed when it starts inside the daemon. */
export interface ModuleContext {
  readonly name: string;
  /** The module's own checkout. */
  readonly dir: string;
  /** Where it keeps state: `data/modules/<name>/`, created for it. */
  readonly dataDir: string;
  readonly log: Logger;
  readonly db: Database;
  readonly config: {
    readonly repo: string;
    readonly workspace: string;
    readonly devRoot: string;
    readonly baseUrl: string;
    readonly token: string;
    /** The daemon's Google OAuth client, the one `/auth/google/callback` is registered with. */
    readonly google: { readonly clientId: string; readonly clientSecret: string };
  };
  readonly env: Readonly<Record<string, string | undefined>>;
  /** One of the daemon's own settings (`data/config.json` over the environment), as the dashboard edits them. */
  readonly setting: (name: string) => string | undefined;
  /** The daemon's sessions: the main conversation, tasks, lookups. */
  readonly sessions: typeof import("../domain/sessions.ts");
  /** Every project sessions can run in: what modules provide (`projects`) and the workspace's contexts. */
  readonly projects: Pick<typeof import("../domain/projects.ts"), "all" | "get">;
  /** Every conversation on disk, per project, the daemon's and terminal ones alike. */
  readonly threads: typeof import("../domain/transcript.ts").allThreads;
  /** Module settings, kept in the database under the module's name. */
  readonly settings: {
    get(key: string): string | undefined;
    set(key: string, value: string | undefined): void;
  };
  /** The event bus: what happens in sessions and modules. */
  readonly on: (listener: (event: PaiEvent) => void) => () => void;
  readonly emit: (kind: string, payload: Record<string, unknown>, sessionId?: string) => void;
  /** What another module exports as its `api` (one this module `requires`), typed by the caller. */
  readonly use: <T>(module: string) => T;
  /** The log every client renders: a module says what it did with `event`. */
  readonly messages: Pick<typeof import("../domain/messages.ts"), "event">;
  /** The one task list: what needs the user lands here. */
  readonly tasks: Pick<typeof import("../domain/tasks.ts"), "list" | "add" | "update">;
  /** The archive `recall` searches. */
  readonly recall: Pick<typeof import("../domain/recall.ts"), "put">;
  /** Where a watcher left off, by key. */
  readonly cursors: typeof import("../core/db.ts").cursors;
  /** An observer's one task per fault, its reason kept current (`watch.ts`). */
  readonly watch: Pick<typeof import("../domain/watch.ts"), "keep">;
  /** Where this checkout stands against what it follows (the self-update core keeps). */
  readonly update: Pick<typeof import("../domain/update.ts"), "status">;
  readonly auth: {
    /** A payload signed with the daemon's key: an OAuth `state` that comes back verified. */
    readonly sign: typeof import("../api/auth.ts").sign;
    /** Where this daemon is as the browser sees it, through the proxy when there is one. */
    readonly origin: typeof import("../api/auth.ts").origin;
    /** `/auth/google/callback` hands a verified state carrying `claim` to `finish`: one redirect URI, several consents. */
    readonly onGoogleCallback: (claim: string, finish: GoogleCallback) => void;
  };
}

/** The second half of a module's Google consent: the callback's request and the state's claims, verified. */
export type GoogleCallback = (req: Request, url: URL, claims: Readonly<Record<string, unknown>>) => Promise<Response> | Response;

/** A module's http outside `/m/`, behind the daemon's auth; `url.pathname` is the whole path. */
export type ModuleRoute = (req: Request, url: URL, ctx: ModuleContext) => Promise<Response | undefined> | Response | undefined;

/** What `pai <name> …` is handed: the API of the daemon it runs next to, and the terminal. */
export type CliIo = Pick<CliContext, "api" | "post" | "fetch" | "out" | "json">;

export interface CliContext {
  readonly name: string;
  readonly dir: string;
  readonly dataDir: string;
  readonly args: readonly string[];
  readonly json: boolean;
  readonly api: (path: string, init?: RequestInit) => Promise<any>;
  readonly post: (path: string, data: unknown) => Promise<any>;
  /** The daemon's API as a raw response (a stream), with the same address and credentials. */
  readonly fetch: (path: string, init?: RequestInit) => Promise<Response>;
  readonly out: (data: unknown, pretty?: () => string) => void;
  /** A spinner on stderr with a label; `update` changes it, `stop` ends it, with a note or not. */
  readonly spin: (label: string) => { update(label: string): void; stop(note?: string): void };
  /** Another module's command line, run right here (a module's `login` that is really the browser's). */
  readonly run: (module: string, args: readonly string[]) => Promise<number>;
}

export interface ModulePrompt {
  readonly text: string;
  readonly kinds: readonly SessionKind[];
}

export interface ModuleHealth {
  readonly ok: boolean;
  readonly detail?: string;
}

/**
 * Whether a connector can act right now: `signed_in`, `signed_out` (never connected, or the login was dropped — `fix`
 * is where to sign in) or `broken` (connected but failing — `detail` says how, `fix` how to repair it).
 */
export type ConnectorState = "signed_in" | "signed_out" | "broken";

export interface ConnectorStatus {
  readonly state: ConnectorState;
  /** Who it is signed in as (`+420…`, `@handle`, an address), or what is wrong. */
  readonly detail?: string;
  readonly fix?: { readonly label: string; readonly url: string };
}

/** What a send came back as, read back out of the channel itself: there, there unconfirmed, or not there. */
export type SendOutcome = "verified" | "unverified" | "not_sent";

export interface ConnectorSend {
  /** A chat, a handle, an address — whatever the channel names a recipient by. */
  readonly to: string;
  readonly text: string;
  readonly subject?: string;
}

export interface SendResult {
  readonly outcome: SendOutcome;
  readonly detail?: string;
}

/**
 * The surface every connector exposes beyond the module's own `events` and `tools`, so clients render all of them
 * from one shape (`GET /connectors`): its state with the link that fixes it, and a send that says whether the
 * message is really there.
 */
export interface Connector {
  /** Asked whether or not the module is enabled or started, so a connector that never started still says why. */
  readonly status: (ctx: ModuleContext) => Promise<ConnectorStatus> | ConnectorStatus;
  readonly send?: (message: ConnectorSend, ctx: ModuleContext) => Promise<SendResult>;
}

/**
 * Two kinds of module: a `connector` is a signed-in outside channel (events in, tools out, sends verified by
 * read-back) and carries `connector`; a `capability` is something the box can do (a browser, coding threads).
 */
export type ModuleKind = "connector" | "capability";

export interface PaiModule {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** Modules this one builds on; they load and start first, and `ctx.use(name)` gives their `api`. */
  readonly requires?: readonly string[];
  /** What other modules get from `ctx.use(this.name)`. */
  readonly api?: object;
  readonly kind?: ModuleKind;
  /** Required for `kind: "connector"`. */
  readonly connector?: Connector;
  /** Off means nothing of it reaches sessions; default on. */
  readonly enabled?: (ctx: ModuleContext) => boolean;
  /** An in-process MCP server per session, built with `createSdkMcpServer` from this file. */
  readonly tools?: {
    /** The MCP server name sessions see the tools under (`mcp__<server>__…`); default the module's name. */
    readonly server?: string;
    readonly kinds: readonly SessionKind[];
    readonly names: readonly string[];
    readonly create: (ref: SessionRef, ctx: ModuleContext) => McpServer;
  };
  /** A paragraph in the system prompt of those sessions, saying what the module is and how to use it; several for different kinds. */
  readonly prompt?: ModulePrompt | readonly ModulePrompt[];
  /** A directory of skills (each `<skill>/SKILL.md`), linked into the workspace so sessions load them. */
  readonly skills?: string;
  /** `pai <name> …`; runs on the box, next to the daemon, with a terminal. */
  readonly cli?: (cli: CliContext) => Promise<number | void>;
  /** What `pai <name> …` accepts, for `pai --help`. */
  readonly commands?: readonly { readonly name: string; readonly description: string }[];
  /** Subcommands that run on the laptop instead (they need its browser, its files); the daemon's API is still the box's. */
  readonly cliHere?: readonly string[];
  /**
   * Top-level words this module answers: `pai <verb> …` runs its `cli` with the verb as the first argument (and
   * `cliHere` is checked against the verb). Listed in `pai --help` beside core's own commands.
   */
  readonly verbs?: readonly ModuleVerb[];
  /** Extra arguments for `claude` started by `pai claude` (dev's channel is added by core, so Paigram reaches that terminal). */
  readonly claudeArgs?: () => readonly string[];
  /** Projects sessions can run in (repositories), beside the workspace's own contexts. */
  readonly projects?: ProjectSource;
  /** Conversations this module holds outside the daemon (a terminal's) that a message can still reach. */
  readonly held?: HeldThreads;
  /** http under `/m/<name>/`; `path` is what follows that prefix. `undefined` is a 404. */
  readonly routes?: (req: Request, path: string, url: URL, ctx: ModuleContext) => Promise<Response | undefined> | Response | undefined;
  /** Path prefixes it answers outside `/m/` (`/gmail/`), behind the daemon's auth: links already out in the world. */
  readonly mounts?: Readonly<Record<string, ModuleRoute>>;
  /**
   * Things connected one at a time with their own consent (mailboxes), for the dashboard: what is
   * connected, where the browser goes to add one (`{label}` is the name asked for), and the DELETE
   * path that forgets one.
   */
  readonly accounts?: {
    readonly list: (ctx: ModuleContext) => readonly { readonly label: string; readonly detail: string }[];
    readonly connectPath: string;
    readonly removePath: string;
    readonly hint: string;
  };
  /** A directory served as static files under `/m/<name>/ui/`. */
  readonly ui?: string;
  readonly settings?: readonly ModuleSetting[];
  readonly events?: readonly { readonly kind: string; readonly description: string }[];
  readonly start?: (ctx: ModuleContext) => Promise<void> | void;
  readonly stop?: () => Promise<void> | void;
  readonly health?: () => Promise<ModuleHealth> | ModuleHealth;
}

export interface ModuleVerb {
  readonly name: string;
  readonly args?: string;
  readonly description: string;
  /** Its own subcommands, for the completion. */
  readonly subcommands?: readonly { readonly name: string; readonly args?: string; readonly description: string }[];
}

export type McpServer = ReturnType<typeof createSdkMcpServer>;
