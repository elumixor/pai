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

export class DevError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DevError";
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${config.dev.url}${path}`, {
    ...init,
    signal: AbortSignal.timeout(TIMEOUT_MS),
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
