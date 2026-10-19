import { track } from "./progress.ts";
import type { AuditEntry, Effort, Agent, AgentInstructions, Ask, Automation, Need, ContextItem, LogMessage, Routine, TaskItem, TaskStatus, Diagnostic, SlashCommand, DiskSession, Entry, ModuleInfo, PaiEvent, ProjectSummary, SessionSummary, Status, SyncReport, TerminalSummary, Usage } from "./types.ts";
import { CACHE_PREFIX, remember } from "./storage.ts";

/**
 * The daemon, with the app's offline story in one place: every GET is cached, a failed GET
 * falls back to that cache, and anything that writes is queued until the daemon answers
 * again. The app itself is local files, so it opens whether or not the box is reachable.
 */

const BASE_KEY = "pai.baseUrl";
const TOKEN_KEY = "pai.token";
const OUTBOX_KEY = "pai.outbox";

export interface TranscriptTool {
  readonly id?: string;
  readonly name: string;
  readonly input?: string;
  readonly result?: string;
}

export interface Transcript {
  readonly role: "user" | "assistant";
  readonly ts: string;
  readonly text: string;
  readonly thinking?: string;
  readonly tools?: readonly TranscriptTool[];
  readonly images?: readonly string[];
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
if (fromLink) remember(TOKEN_KEY, fromLink);

export const token = () => localStorage.getItem(TOKEN_KEY) ?? "";
export const setToken = (value: string) => remember(TOKEN_KEY, value.trim());

/** EventSource and WebSocket cannot carry a header, so those URLs carry the token instead. */
export function withToken(url: string) {
  if (!token()) return url;
  return `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token())}`;
}

const headers = (extra?: Record<string, string>) => ({
  ...extra,
  ...(token() ? { authorization: `Bearer ${token()}` } : {}),
});

/**
 * Served by the daemon, the page's own origin is the API — a remembered address from an
 * earlier visit (the tailnet one, say) would be a different origin, or plain http under an
 * https page, which the browser refuses. The stored address is for the desktop app.
 */
export const baseUrl = () => (servedByDaemon ? location.origin : (localStorage.getItem(BASE_KEY) ?? CANDIDATES[0]!));

/** First run has no address to talk to, so the usual places are tried before anything renders. */
export async function resolveBase() {
  if (servedByDaemon || localStorage.getItem(BASE_KEY)) return baseUrl();
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
export const setBaseUrl = (url: string) => remember(BASE_KEY, url.replace(/\/$/, ""));

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

/** The largest GET response the offline cache keeps, in characters. */
const CACHE_MAX = 200_000;
const cache = {
  read<T>(path: string): T | undefined {
    const raw = localStorage.getItem(CACHE_PREFIX + path);
    return raw ? (JSON.parse(raw) as T) : undefined;
  },
  write(path: string, value: unknown) {
    const raw = JSON.stringify(value);
    // What is too big to keep is not kept: a transcript's worth would push everything else out.
    if (raw.length > CACHE_MAX) return;
    remember(CACHE_PREFIX + path, raw);
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
/** `quiet` keeps a poll made on a timer off the progress bar. */
export const get = <T>(path: string, quiet = false): Promise<T> => (quiet ? fetchGet<T>(path) : track(fetchGet<T>(path)));

async function fetchGet<T>(path: string): Promise<T> {
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
export const send = (path: string, body: unknown, method = "POST") => track(fetchSend(path, body, method));

async function fetchSend(path: string, body: unknown, method: string): Promise<{ queued: boolean; error?: string; data?: unknown }> {
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
  remember(OUTBOX_KEY, JSON.stringify([...outbox(), item]));
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
    remember(OUTBOX_KEY, JSON.stringify(pending));
  }
  return outbox().length;
}

/** `/tasks` is the task list (`items`) plus the sessions (`live`, `recent`); a daemon before the staff had only the sessions. */
export const tasks = () => get<{ items?: TaskItem[]; live: SessionSummary[]; recent: SessionSummary[] }>("/tasks");
export const projects = () => get<ProjectSummary[]>("/projects");
export const status = () => get<Status>("/health");
export const settings = () => get<Settings>("/settings");
export const terminals = () => get<TerminalSummary[]>("/terminals", true);
export const usage = () => get<Usage>("/usage", true);
export const syncReports = () => get<SyncReport[]>("/sync", true);
export const commands = (session: string) => get<SlashCommand[]>(`/commands?session=${session}`);
export const diagnostics = (path: string, fresh = false) => get<{ project?: string; items: Diagnostic[] }>(`/diagnostics?path=${encodeURIComponent(path)}${fresh ? "&fresh=1" : ""}`);
export const modules = () => get<ModuleInfo[]>("/modules");
export const patchModule = (name: string, changes: Record<string, string>) => send(`/modules/${name}`, changes, "PATCH");
export const pollModule = (name: string) => send(`/modules/${name}/poll`, {});
export const automations = () => get<Automation[]>("/automations");
export const createAutomation = (input: Partial<Automation>) => send("/automations", input);
export const updateAutomation = (id: number, changes: Partial<Automation>) => send(`/automations/${id}`, changes, "PATCH");
export const deleteAutomation = (id: number) => send(`/automations/${id}`, {}, "DELETE");
export const contextItems = () => get<{ surfaces: string[]; items: ContextItem[] }>("/context");
export const createContextProject = (name: string, about: string) => send("/projects", { name, about });
export const recentEvents = (limit = 60) => get<PaiEvent[]>(`/events?limit=${limit}`);
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
export const saveFile = (path: string, text: string) => send("/file", { path, text }, "PUT");
export const fileIndex = (path: string) => get<string[]>(`/files/index?path=${encodeURIComponent(path)}`);
export const file = (path: string) => get<{ path: string; text: string; truncated?: boolean }>(`/file?path=${encodeURIComponent(path)}`);
export const transcript = (session: string, cwd?: string, limit = 300) =>
  get<Transcript[]>(`/transcript?session=${session}&limit=${limit}${cwd ? `&cwd=${encodeURIComponent(cwd)}` : ""}`);
/** A picture from a transcript, as an `<img>` can load it (it cannot carry the header). */
export const message = (id: number) => get<LogMessage>(`/messages/${id}`);
export const mapUrl = (lat: number, lon: number, width = 600, height = 220) => withToken(`${baseUrl()}/map?lat=${lat}&lon=${lon}&w=${width}&h=${height}`);
export const attachmentUrl = (name: string) => withToken(`${baseUrl()}/attachments/${encodeURIComponent(name)}`);
/** One tool call in full, from the session's transcript: the input and the output the previews cut. */
export const toolCall = (session: string, tool: string) => get<{ name: string; input: unknown; result?: string }>(`/transcript/tool?session=${session}&tool=${encodeURIComponent(tool)}`);
/** A new plain thread, on its own: no agent, no project; its first message goes with it. */
export const startThread = (text: string, images: { media_type: string; data: string }[] = [], project?: string) => send("/task", { title: "", text, images, project, origin: project ? undefined : "general" });
/** A turn in a plain thread, a terminal's included (into the terminal while its channel is connected). */
export const sendThread = (id: string, text: string, images: { media_type: string; data: string }[] = []) => send("/send", { id, text, images });
export const threadsIn = (cwd: string, limit?: number) => get<DiskSession[]>(`/threads?cwd=${encodeURIComponent(cwd)}${limit ? `&limit=${limit}` : ""}`);

// ---- the staff: pai and its agents, the message log, tasks, asks, routines ----------------

export const agents = () => get<Agent[]>("/agents");
/** One agent's chat, or with `task` that task's thread whoever wrote in it. */
export const messages = (agent: string, options: { before?: number; after?: number; limit?: number; task?: number } = {}) =>
  get<LogMessage[]>(`/messages?${options.task ? `task=${options.task}` : `agent=${encodeURIComponent(agent)}`}&limit=${options.limit ?? 100}${options.before ? `&before=${options.before}` : ""}${options.after ? `&after=${options.after}` : ""}`);
/** The newest rows of the given kinds, whoever they are between: what the bell lists. */
export const notices = (kinds: readonly string[], limit = 40) => get<LogMessage[]>(`/messages?kinds=${kinds.join(",")}&limit=${limit}`, true);
/** The outward tool calls — sends, writes, clicks in signed-in sites — newest first. */
export const snapshot = () => get<{ text: string }>("/snapshot");
export const importSnapshot = (text: string) => send("/snapshot", { text });
export const auditTrail = (limit = 40) => get<AuditEntry[]>(`/audit?limit=${limit}`, true);
export const messageHeadline = (id: number) => get<{ headline: string | null; enabled: boolean }>(`/messages/${id}/headline`);
export const messageTldr = (id: number) => get<{ tldr: string | null; enabled: boolean }>(`/messages/${id}/tldr`);
export const messageAgent = (slug: string, text: string, taskId?: number, images: { media_type: string; data: string }[] = []) => send(`/agents/${slug}/message`, { text, taskId, images });
/** What an agent is told: its own files and the instructions appended to Claude Code's. */
export const agentInstructions = (slug: string) => get<AgentInstructions>(`/agents/${slug}/instructions`);
export const configureAgent = (slug: string, changes: { bubble?: boolean; name?: string; parent?: string }) => send(`/agents/${slug}`, changes, "PATCH");
export const closeAgent = (slug: string) => send(`/agents/${slug}/close`, {});
export const taskItems = async () => (await tasks()).items ?? [];
export const createTask = (input: { title: string; owner?: string; due?: string; status?: TaskStatus }) => send("/tasks", input);
export const updateTask = (id: number, changes: { status?: TaskStatus; title?: string; owner?: string; due?: string | null; nextAction?: string; notes?: string; parentId?: number | null }) => send(`/tasks/${id}`, changes, "PATCH");
export const asks = () => get<Ask[]>("/asks");
export const needs = () => get<Need[]>("/needs");
export const reconfigure = (id: string, changes: { model?: string | null; effort?: Effort | null }) => send("/reconfigure", { id, ...changes });
export const dropAsk = (id: number) => send(`/asks/${id}/drop`, {});
export const answerNeed = (id: string, text: string) => send("/needs/answer", { id, text });
export const agent = (slug: string) => get<Agent & { children: Agent[]; tasks: TaskItem[] }>(`/agents/${slug}`);
export const task = (id: number) => get<TaskItem & { children: TaskItem[] }>(`/tasks/${id}`);
/** Every task, closed ones included. */
export const allTasks = async () => (await get<{ items?: TaskItem[] }>("/tasks?all=1")).items ?? [];
export const pai = () => get<{ session: SessionSummary; thread: number | null; lastRotation: unknown }>("/pai");
export const sendPai = (text: string, images: { media_type: string; data: string }[] = []) => send("/pai", { text, images });
export const answerQuestion = (session: string, text: string) => send("/answer", { id: session, text });
export const answerAsk = (id: number, text: string) => send(`/asks/${id}/answer`, { text });
export const routines = () => get<Routine[]>("/routines");

export interface FollowOptions {
  /** Text as it streams; a thread view wants it, the rail does not. */
  readonly deltas?: boolean;
  /** The last events before connecting; off for a view that already has the transcript. */
  readonly replay?: boolean;
  /** The stream came back after being away: the host re-reads what it cannot have been told. */
  readonly onReconnect?: () => void;
}

/** The daemon's event stream. Reconnects by itself; silence is simply treated as offline. */
export function follow(session: string | undefined, onEvent: (event: PaiEvent) => void, options: FollowOptions = {}) {
  let source: EventSource | undefined;
  let stopped = false;
  let opened = false;

  const connect = () => {
    if (stopped) return;
    const query = `follow=1${session ? `&session=${session}` : ""}${options.deltas ? "&deltas=1" : ""}${options.replay === false ? "&replay=0" : ""}`;
    source = new EventSource(withToken(`${baseUrl()}/events?${query}`));
    source.addEventListener("message", (message) => {
      setOnline(true);
      onEvent(JSON.parse(message.data as string) as PaiEvent);
    });
    // A reconnection means the stream (or the daemon) was away: whatever happened meanwhile was
    // never delivered, so the host re-reads the state rather than trusting what it last drew. A
    // spinner left behind by a daemon restart is exactly this.
    source.addEventListener("open", () => {
      setOnline(true);
      if (opened) options.onReconnect?.();
      opened = true;
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
