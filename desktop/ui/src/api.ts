import type { Entry, PaiEvent, ProjectSummary, SessionSummary, Status, TerminalSummary, Usage } from "./types.ts";

/**
 * The daemon, with the app's offline story in one place: every GET is cached, a failed GET
 * falls back to that cache, and anything that writes is queued until the daemon answers
 * again. The app itself is local files, so it opens whether or not the box is reachable.
 */

const BASE_KEY = "pai.baseUrl";
const TOKEN_KEY = "pai.token";
const CACHE_PREFIX = "pai.cache:";
const OUTBOX_KEY = "pai.outbox";

export interface Transcript {
  readonly role: "user" | "assistant";
  readonly ts: string;
  readonly text: string;
  readonly thinking?: string;
  readonly tools?: readonly { readonly name: string; readonly input?: string }[];
  readonly meta?: boolean;
}

export interface Settings {
  readonly editable: readonly string[];
  readonly effective: Record<string, string>;
  readonly overrides: Record<string, string>;
}

interface Queued {
  readonly path: string;
  readonly method: string;
  readonly body: unknown;
  readonly at: number;
}

/**
 * Where a daemon usually is. Served by the daemon itself (`/ui`), it is simply this page's
 * own origin; in the desktop app it is this machine, then the box on the tailnet.
 */
const servedByDaemon = location.protocol.startsWith("http") && location.pathname.startsWith("/ui");
const CANDIDATES = [...(servedByDaemon ? [location.origin] : []), "http://127.0.0.1:8787", "http://pai:8787"];

const tauri = (globalThis as { __TAURI__?: { core: { invoke(name: string): Promise<string | null> } } }).__TAURI__;

/** Whether this is the desktop window, as opposed to the same bundle in a browser tab. */
export const inDesktop = Boolean(tauri);

let devConfig: Promise<{ baseUrl?: string; token?: string }> | undefined;

/**
 * The address and token the rest of pai already agreed on (`~/.config/pai/menubar`): the
 * desktop shell reads the file; `bun run dev` serves it at `/__config`.
 */
async function configured(what: "configured_base_url" | "configured_token") {
  if (tauri) return (await tauri.core.invoke(what).catch(() => null)) ?? undefined;
  if (servedByDaemon) return undefined;
  devConfig ??= fetch("/__config").then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  const found = await devConfig;
  return what === "configured_base_url" ? found.baseUrl : found.token;
}

/** The shared secret, if the daemon asks for one. A link may carry it: `…/ui/?token=…`. */
const fromLink = new URLSearchParams(location.search).get("token");
if (fromLink) localStorage.setItem(TOKEN_KEY, fromLink);

export const token = () => localStorage.getItem(TOKEN_KEY) ?? "";
export const setToken = (value: string) => localStorage.setItem(TOKEN_KEY, value.trim());

/** EventSource and WebSocket cannot carry a header, so those URLs carry the token instead. */
export function withToken(url: string) {
  if (!token()) return url;
  return `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token())}`;
}

const headers = (extra?: Record<string, string>) => ({
  ...extra,
  ...(token() ? { authorization: `Bearer ${token()}` } : {}),
});

export const baseUrl = () => localStorage.getItem(BASE_KEY) ?? CANDIDATES[0]!;

/** First run has no address to talk to, so the usual places are tried before anything renders. */
export async function resolveBase() {
  if (localStorage.getItem(BASE_KEY)) return baseUrl();
  if (!token()) {
    const known = await configured("configured_token");
    if (known) setToken(known);
  }
  const preferred = await configured("configured_base_url");
  for (const candidate of [...(preferred ? [preferred] : []), ...CANDIDATES]) {
    try {
      const response = await fetch(`${candidate}/health`, { headers: headers(), signal: AbortSignal.timeout(2500) });
      if (response.ok) {
        setBaseUrl(candidate);
        return candidate;
      }
    } catch {
      /* try the next one */
    }
  }
  return baseUrl();
}
export const setBaseUrl = (url: string) => localStorage.setItem(BASE_KEY, url.replace(/\/$/, ""));

let online = true;
const listeners = new Set<(online: boolean) => void>();

export function onConnection(listener: (online: boolean) => void) {
  listeners.add(listener);
  listener(online);
}

function setOnline(next: boolean) {
  if (next === online) return;
  online = next;
  for (const listener of listeners) listener(online);
  if (next) void flush();
}

export const isOnline = () => online;

const cache = {
  read<T>(path: string): T | undefined {
    const raw = localStorage.getItem(CACHE_PREFIX + path);
    return raw ? (JSON.parse(raw) as T) : undefined;
  },
  write(path: string, value: unknown) {
    try {
      localStorage.setItem(CACHE_PREFIX + path, JSON.stringify(value));
    } catch {
      /* a full quota is not worth failing a render over */
    }
  },
};

/** Why the last request failed, so the client can say something better than "offline". */
export let lastError = "";

async function fetchFrom<T>(base: string, path: string): Promise<T> {
  const response = await fetch(base + path, { headers: headers(), signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return (await response.json()) as T;
}

/**
 * A GET that prefers the daemon it is pointed at, falls back to another one it can reach —
 * the box when this network can see it, the daemon on this machine when it cannot — and
 * settles for the last answer it was given.
 */
export async function get<T>(path: string): Promise<T> {
  try {
    const data = await fetchFrom<T>(baseUrl(), path);
    setOnline(true);
    cache.write(path, data);
    return data;
  } catch (err) {
    lastError = (err as Error).message;
    for (const candidate of await alternatives()) {
      try {
        const data = await fetchFrom<T>(candidate, path);
        setBaseUrl(candidate);
        setOnline(true);
        cache.write(path, data);
        return data;
      } catch {
        /* try the next one */
      }
    }
    const cached = cache.read<T>(path);
    setOnline(false);
    if (cached !== undefined) return cached;
    throw err;
  }
}

/** Everywhere a daemon might be, apart from the one that just failed. */
async function alternatives() {
  const configuredUrl = await configured("configured_base_url");
  return [...(configuredUrl ? [configuredUrl] : []), ...CANDIDATES].filter((candidate) => candidate !== baseUrl());
}

/**
 * A write goes to the daemon, or into the outbox to be replayed when it answers again. A
 * request the daemon refused is not queued: it would be refused again, so the error is
 * returned instead.
 */
export async function send(path: string, body: unknown, method = "POST"): Promise<{ queued: boolean; error?: string; data?: unknown }> {
  let response: Response;
  try {
    response = await fetch(baseUrl() + path, {
      method,
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5 * 60 * 1000),
    });
  } catch {
    queue({ path, method, body, at: Date.now() });
    setOnline(false);
    return { queued: true };
  }
  setOnline(true);
  const data: unknown = await response.json().catch(() => undefined);
  if (!response.ok) return { queued: false, error: (data as { error?: string } | undefined)?.error ?? `${path}: ${response.status}` };
  return { queued: false, data };
}

export const outbox = (): Queued[] => JSON.parse(localStorage.getItem(OUTBOX_KEY) ?? "[]") as Queued[];

function queue(item: Queued) {
  localStorage.setItem(OUTBOX_KEY, JSON.stringify([...outbox(), item]));
}

/** Replays what was written while the daemon was away, oldest first, and stops at the first failure. */
export async function flush() {
  const pending = outbox();
  while (pending.length) {
    const item = pending[0]!;
    try {
      const response = await fetch(baseUrl() + item.path, {
        method: item.method,
        headers: headers({ "content-type": "application/json" }),
        body: JSON.stringify(item.body),
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error(String(response.status));
    } catch {
      break;
    }
    pending.shift();
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(pending));
  }
  return outbox().length;
}

export const tasks = () => get<{ live: SessionSummary[]; recent: SessionSummary[] }>("/tasks");
export const projects = () => get<ProjectSummary[]>("/projects");
export const status = () => get<Status>("/health");
export const settings = () => get<Settings>("/settings");
export const terminals = () => get<TerminalSummary[]>("/terminals");
export const sync = () =>
  get<{
    enabled: boolean;
    running: boolean;
    deviceId: string;
    peer: string;
    folders: { id: string; state?: string; needBytes?: number; path?: string }[];
  }>("/sync");
export const usage = () => get<Usage>("/usage");
export const addProject = (url: string, name?: string) => send("/projects", { url, name });
export const openTerminal = async (project?: string, cwd?: string) => {
  const response = await fetch(`${baseUrl()}/terminals`, {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({ ...(project ? { project } : {}), ...(cwd ? { cwd } : {}) }),
  });
  if (!response.ok) throw new Error(`terminal: ${response.status}`);
  return (await response.json()) as TerminalSummary;
};
export const closeTerminal = (id: string) =>
  fetch(`${baseUrl()}/terminals/${id}`, { method: "DELETE", headers: headers() }).catch(() => undefined);
export const entries = (path: string) => get<Entry[]>(`/files?path=${encodeURIComponent(path)}`);
export const file = (path: string) => get<{ path: string; content: string; truncated?: boolean }>(`/file?path=${encodeURIComponent(path)}`);
export const transcript = (session: string, limit = 300) =>
  get<Transcript[]>(`/transcript?session=${session}&limit=${limit}`);

/** The daemon's event stream. Reconnects by itself; silence is simply treated as offline. */
export function follow(session: string | undefined, onEvent: (event: PaiEvent) => void) {
  let source: EventSource | undefined;
  let stopped = false;

  const connect = () => {
    if (stopped) return;
    source = new EventSource(withToken(`${baseUrl()}/events?follow=1${session ? `&session=${session}` : ""}`));
    source.addEventListener("message", (message) => {
      setOnline(true);
      onEvent(JSON.parse(message.data as string) as PaiEvent);
    });
    source.addEventListener("error", () => {
      setOnline(false);
      source?.close();
      setTimeout(connect, 4000);
    });
  };

  connect();
  return () => {
    stopped = true;
    source?.close();
  };
}
