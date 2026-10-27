import { config } from "../core/config.ts";
import { logger } from "../core/log.ts";
import type { Image } from "./attachments.ts";
import { keep } from "./attachments.ts";
import type { Project, ProjectSource } from "./projects.ts";

/**
 * dev — the development platform, a separate system on the same box — as pai's source of repositories and the way
 * a message reaches a terminal's `claude`. pai never imports dev; it asks dev's API (`PAI_DEV_URL`,
 * `PAI_DEV_TOKEN`). Sessions reach dev's richer surface (files, diffs, commands, sessions) through its MCP server,
 * added for them with `claude mcp add`.
 *
 * The projects are fetched now and then and kept, so the synchronous `ProjectSource` answers from memory; a dev
 * that is down leaves the last list in place.
 */

const log = logger("dev");
const REFRESH_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 5000;
/** A tool may clone or make a worktree before it answers. */
const TOOL_TIMEOUT_MS = 60_000;

export class DevError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DevError";
  }
}

async function call<T>(path: string, init: RequestInit = {}, timeoutMs = TIMEOUT_MS): Promise<T> {
  const res = await fetch(`${config.dev.url}${path}`, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "content-type": "application/json", ...(config.dev.token ? { authorization: `Bearer ${config.dev.token}` } : {}) },
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new DevError(data.error ?? `${path}: ${res.status}`);
  return data;
}

let projects: readonly Project[] = [];

async function load() {
  try {
    projects = await call<Project[]>("/projects");
  } catch (err) {
    log.warn(`projects from dev: ${(err as Error).message}`);
  }
}

export const source: ProjectSource = {
  all: () => projects,
  refresh: () => void load(),
};

/** Fetches the projects now (so the first sessions have them) and every few minutes. */
export async function start() {
  await load();
  log.info(`${projects.length} projects from ${config.dev.url}`);
  const timer = setInterval(() => void load(), REFRESH_MS);
  return () => clearInterval(timer);
}

/**
 * Into the terminal whose channel holds this conversation; false when none does (or dev cannot be reached), and
 * the caller continues the conversation itself.
 */
export async function deliver(sessionId: string, text: string, images: readonly Image[] = []): Promise<boolean> {
  try {
    const { delivered } = await call<{ delivered: boolean }>(`/sessions/${sessionId}/deliver`, {
      method: "POST",
      body: JSON.stringify({ text, images: images.map((image) => ({ ...image, name: keep(image) })) }),
    });
    return delivered;
  } catch (err) {
    log.warn(`deliver ${sessionId.slice(0, 6)}: ${(err as Error).message}`);
    return false;
  }
}

/** One tool of dev's MCP server, its text result read back as JSON. */
async function tool<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const reply = await call<{ error?: { message: string }; result?: { isError?: boolean; content?: { text?: string }[] } }>("/mcp", {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  }, TOOL_TIMEOUT_MS);
  const text = reply.result?.content?.[0]?.text ?? "";
  if (reply.error || reply.result?.isError) throw new DevError(`${name}: ${reply.error?.message ?? text}`);
  return JSON.parse(text || "null") as T;
}

export interface StartedSession {
  /** dev's session id (the Claude Code session id). */
  readonly id: string;
  /** `dev:session/<id>`. */
  readonly urn: string;
  readonly url?: string;
}

/** A Claude Code session dev runs for a Keep task: in a worktree of the project when the project asks for one. */
export async function startSession(input: { project: string; keepUrn: string; title: string; brief: string }): Promise<StartedSession> {
  const started = await tool<{ session?: string; id?: string; url?: string }>("start_session", {
    project: input.project,
    keep_urn: input.keepUrn,
    title: input.title,
    brief: input.brief,
    // dev before the keep flow took the brief as `prompt`.
    prompt: input.brief,
  });
  const id = started.session?.replace(/^dev:session\//, "") ?? started.id;
  if (!id) throw new DevError("start_session answered without a session");
  return { id, urn: `dev:session/${id}`, url: started.url };
}

/** Whether a session's turn is running now; undefined when dev does not know it (yet). */
export async function sessionBusy(id: string): Promise<boolean | undefined> {
  try {
    const { session } = await call<{ session: { busy: boolean; running?: boolean } }>(`/sessions/${id}?limit=1`);
    return session.busy || Boolean(session.running);
  } catch (err) {
    if (err instanceof DevError && /no session|no conversation/.test(err.message)) return undefined;
    throw err;
  }
}
