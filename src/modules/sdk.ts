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

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { recentEvents, waitFor } from "../core/bus.ts";

export type { SessionKind, SessionRef, PaiEvent, ModuleSetting };

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
  };
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The daemon's sessions: the main conversation, tasks, lookups. */
  readonly sessions: typeof import("../domain/sessions.ts");
  readonly catalog: typeof import("../domain/catalog.ts");
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
}

/** What `pai <name> …` is handed: the API of the daemon it runs next to, and the terminal. */
export interface CliContext {
  readonly name: string;
  readonly dir: string;
  readonly dataDir: string;
  readonly args: readonly string[];
  readonly json: boolean;
  readonly api: (path: string, init?: RequestInit) => Promise<any>;
  readonly post: (path: string, data: unknown) => Promise<any>;
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
  readonly status: () => Promise<ConnectorStatus> | ConnectorStatus;
  readonly send?: (message: ConnectorSend) => Promise<SendResult>;
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
  /** http under `/m/<name>/`; `path` is what follows that prefix. `undefined` is a 404. */
  readonly routes?: (req: Request, path: string, url: URL, ctx: ModuleContext) => Promise<Response | undefined> | Response | undefined;
  /** A directory served as static files under `/m/<name>/ui/`. */
  readonly ui?: string;
  readonly settings?: readonly ModuleSetting[];
  readonly events?: readonly { readonly kind: string; readonly description: string }[];
  readonly start?: (ctx: ModuleContext) => Promise<void> | void;
  readonly stop?: () => Promise<void> | void;
  readonly health?: () => Promise<ModuleHealth> | ModuleHealth;
}

export type McpServer = ReturnType<typeof createSdkMcpServer>;
