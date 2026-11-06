import { auth } from "./auth.svelte";
import { track } from "./progress.svelte";
import type {
  Agent,
  TrashedThread,
  Ask,
  AuditEntry,
  ConnectorDetail,
  ConnectorSummary,
  ChatConfig,
  ContextItem,
  DiskSession,
  Effort,
  LogMessage,
  Need,
  Routine,
  RoutineEvent,
  RoutineFields,
  SessionSummary,
  SlashCommand,
  SpendReport,
  Status,
  TaskItem,
  ToolProviders,
  TaskStatus,
  Transcript,
  Upload,
  Usage,
  AgentSheet,
} from "./types";

/** A refusal from the daemon, with its own words. */
export class DaemonError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "DaemonError";
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers = { ...(await auth.header()), ...(body === undefined ? {} : { "content-type": "application/json" }) };
  const response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  const parsed = text ? (JSON.parse(text) as unknown) : null;
  if (!response.ok) throw new DaemonError(response.status, (parsed as { error?: string } | null)?.error ?? `${path}: ${response.status}`);
  return parsed as T;
}

/** A read; `quiet` keeps a poll made on a timer off the progress bar. */
/** How sure Jev is of a blank chat's picks, 0 to 1. */
export interface ChatConfidence {
  readonly kind: Record<string, number>;
  readonly project?: number;
  readonly model: number;
  readonly effort: number;
}

export const get = <T>(path: string, quiet = false) => (quiet ? request<T>("GET", path) : track(request<T>("GET", path)));

/** The answer to a write: what came back, or the daemon's reason for refusing it. A write never throws at the caller. */
export interface Sent<T = unknown> {
  readonly data?: T;
  readonly error?: string;
}

export async function send<T = unknown>(path: string, body: unknown = {}, method = "POST"): Promise<Sent<T>> {
  try {
    return { data: await track(request<T>(method, path, body)) };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

const q = encodeURIComponent;

export const api = {
  status: () => get<Status>("/health"),
  usage: () => get<Usage>("/usage", true),
  models: () => get<{ latest: Record<string, { id: string; name: string }> }>("/models").then((r) => r.latest),
  commands: (session: string) => get<SlashCommand[]>(`/commands?session=${q(session)}`),
  rates: () => get<{ base: string; date: string; rates: Record<string, number>; currencies: string[] }>("/rates", true),
  readMarks: async () => (await get<{ marks: Record<string, number> }>("/reads", true)).marks ?? {},
  markRead: (place: string, at: number) => request("POST", "/reads", { place, at }),

  // Quiet: the editor saves as he works, and that is no progress to show.
  themes: async () => (await get<{ themes: readonly unknown[] }>("/themes", true)).themes,
  saveTheme: (theme: { readonly id: string }) => request("PUT", `/themes/${q(theme.id)}`, theme),
  dropTheme: (id: string) => request("DELETE", `/themes/${q(id)}`),

  // ---- the staff: pai, its agents, the log, tasks, asks -------------------------------------
  pai: () => get<{ session: SessionSummary; thread: number | null; lastRotation: unknown }>("/pai"),
  sendPai: (text: string, images: readonly Upload[] = []) => send<SessionSummary>("/pai", { text, images }),
  agents: () => get<Agent[]>("/agents"),
  messageAgent: (slug: string, text: string, taskId?: number, images: readonly Upload[] = []) => send<LogMessage>(`/agents/${slug}/message`, { text, taskId, images }),
  /** The trash: threads deleted, newest first, and how many days they wait there before going for good. */
  trash: () => get<{ items: TrashedThread[]; days: number }>("/sessions/trash", true),
  trashThreads: (ids: readonly string[]) => send<{ ids: string[] }>("/sessions/trash", { ids }),
  restoreThreads: (ids: readonly string[]) => send<{ ids: string[] }>("/sessions/restore", { ids }),
  purgeThreads: (ids: readonly string[]) => send<{ ids: string[] }>("/sessions/purge", { ids }),
  /** Puts threads under a session, an agent (`agent:<slug>`) or at the top (`null`). */
  moveThreads: (ids: readonly string[], parent: string | null) => send<{ moved: string[] }>("/sessions/move", { ids, parent }),
  agentSheet: (slug: string) => get<AgentSheet>(`/agents/${slug}/sheet`),
  stopAgent: (slug: string, reason?: string) => send<{ stopped: string[] }>(`/agents/${slug}/stop`, { reason }),
  resumeAgent: (slug: string) => send(`/agents/${slug}/resume`, {}),
  killAgent: (slug: string, summary?: string) => send(`/agents/${slug}/close`, { summary }),
  trashAgent: (slug: string) => send(`/agents/${slug}/trash`, {}),
  restoreAgent: (slug: string) => send(`/agents/${slug}/restore`, {}),
  purgeAgent: (slug: string) => send(`/agents/${slug}/purge`, {}),
  agentTrash: () => get<{ items: Agent[]; days: number }>("/agents/trash", true),
  prefs: () => get<Record<string, unknown>>("/prefs", true),
  savePrefs: (changes: Record<string, unknown>) => request("PUT", "/prefs", changes),
  configureAgent: (slug: string, changes: { bubble?: boolean; name?: string; parent?: string }) => send(`/agents/${slug}`, changes, "PATCH"),
  messages: (agent: string, options: { before?: number; limit?: number; task?: number } = {}) =>
    get<LogMessage[]>(`/messages?${options.task ? `task=${options.task}` : `agent=${q(agent)}`}&limit=${options.limit ?? 100}${options.before ? `&before=${options.before}` : ""}`),
  /** The newest rows of the given kinds, whoever they are between: what the bell lists. */
  notices: (kinds: readonly string[], limit = 40) => get<LogMessage[]>(`/messages?kinds=${kinds.join(",")}&limit=${limit}`, true),
  message: (id: number) => get<LogMessage>(`/messages/${id}`),
  headline: (id: number) => get<{ headline: string | null; enabled: boolean }>(`/messages/${id}/headline`, true),
  tasks: async () => (await get<{ items?: TaskItem[] }>("/tasks")).items ?? [],
  /** Every task, closed ones included. */
  allTasks: async () => (await get<{ items?: TaskItem[] }>("/tasks?all=1")).items ?? [],
  /** The sessions running now and the most recent ones, live or not: what the tree is built from. */
  sessions: (limit = 400) => get<{ live: SessionSummary[]; recent: SessionSummary[] }>(`/sessions?limit=${limit}`, true),
  task: (id: number) => get<TaskItem & { children: TaskItem[] }>(`/tasks/${id}`),
  createTask: (input: { title: string; owner?: string; due?: string; status?: TaskStatus }) => send<TaskItem>("/tasks", input),
  updateTask: (id: number, changes: Partial<Pick<TaskItem, "status" | "title" | "owner" | "nextAction" | "notes">> & { due?: string | null; parentId?: number | null }) =>
    send<TaskItem>(`/tasks/${id}`, changes, "PATCH"),
  asks: () => get<Ask[]>("/asks"),
  needs: () => get<Need[]>("/needs"),
  answerNeed: (id: string, text: string) => send("/needs/answer", { id, text }),
  answerAsk: (id: number, text: string) => send(`/asks/${id}/answer`, { text }),
  dropAsk: (id: number) => send(`/asks/${id}/drop`, {}),
  answerQuestion: (session: string, text: string) => send("/answer", { id: session, text }),
  editDraft: (id: number, fields: Record<string, string>) => send(`/drafts/${id}`, fields, "PATCH"),
  sendDraft: (id: number, fields: Record<string, string>) => send(`/drafts/${id}/send`, fields),
  discardDraft: (id: number, why = "") => send(`/drafts/${id}/discard`, { why }),
  audit: (limit = 40) => get<AuditEntry[]>(`/audit?limit=${limit}`, true),

  // ---- threads: plain conversations and their transcripts ------------------------------------
  transcript: (session: string, limit = 300, cwd?: string) => get<Transcript[]>(`/transcript?session=${q(session)}&limit=${limit}${cwd ? `&cwd=${q(cwd)}` : ""}`),
  toolCall: (session: string, tool: string) => get<{ name: string; input: unknown; result?: string }>(`/transcript/tool?session=${q(session)}&tool=${q(tool)}`),
  threadsIn: (cwd: string, limit?: number) => get<DiskSession[]>(`/threads?cwd=${q(cwd)}${limit ? `&limit=${limit}` : ""}`),
  /** A new plain thread, on its own or under the thread it is started from; its first message goes with it. */
  startThread: (text: string, images: readonly Upload[] = [], parent?: string, prefs: { model?: string; effort?: Effort; private?: boolean } = {}) => send<SessionSummary>("/task", { title: "", text, images, parent, origin: "general", ...prefs }),
  startDevTask: (text: string, project: string, model?: string) => send<{ sessionId: string }>("/dev-task", { text, project, model }),
  suggestChat: (text: string) => send<{ kind: "detached" | "dev" | "goal"; project?: string; model: string; effort: Effort; confidence: ChatConfidence }>("/new/suggest", { text }),
  projects: () => get<{ slug: string }[]>("/projects", true),
  contextUsage: (session: string) => get<{ percentage?: number; totalTokens?: number; maxTokens?: number }>(`/context-usage?session=${q(session)}`, true),
  sendThread: (id: string, text: string, images: readonly Upload[] = [], adopt?: { cwd?: string; title?: string }) => send("/send", { id, text, images, ...adopt }),
  stop: (id: string) => send<{ stopped?: boolean }>("/stop", { id }),
  forks: (id: string) => get<{ turn: number; ids: string[] }[]>(`/forks?id=${q(id)}`),
  fork: (id: string, turn: number, text: string, images: readonly Upload[]) => send<SessionSummary>("/fork", { id, turn, text, images }),
  hiddenTurns: (session: string) => get<number[]>(`/hidden?session=${q(session)}`),
  deleteMessages: (input: { ids?: number[]; session?: string; ats?: number[] }) => send("/messages/delete", input),
  closePrivate: (id: string) => send("/private/close", { id }),
  reconfigure: (id: string, changes: { model?: string | null; effort?: Effort | null }) => send("/reconfigure", { id, ...changes }),

  // ---- the pages about the daemon -------------------------------------------------------------
  connectors: () => get<ConnectorSummary[]>("/connectors"),
  switchConnector: (name: string, on: boolean) => send<ConnectorDetail>(`/connectors/${q(name)}/${on ? "connect" : "disconnect"}`),
  draftPolicies: () => get<Record<string, "ask" | "auto">>("/drafts/policy"),
  setDraftPolicy: (channel: string, mode: "ask" | "auto") => send<Record<string, "ask" | "auto">>("/drafts/policy", { channel, mode }, "PATCH"),
  triaged: (before?: number) => get<{ items: import("./stores/inbox.svelte").InboxEntry[] }>(`/inbox?view=triage${before ? `&before=${before}` : ""}`, true),
  triagedBetween: (from: number, to: number) => get<{ items: import("./stores/inbox.svelte").InboxEntry[] }>(`/inbox?from=${from}&to=${to}`, true),
  itemText: (id: string) => get<{ text: string }>(`/inbox/${q(id)}/text`, true),
  tellAboutItem: (id: string) => send(`/inbox/${q(id)}/tell`),
  sent: () => get<{ id: string; agent: string | null; tool: string; summary: string; ts: number; outcome: "verified" | "unverified" | "not_sent" | "done" | "running" }[]>("/sent", true),
  connector: (name: string, quiet = false) => get<ConnectorDetail>(`/connectors/${q(name)}`, quiet),
  /** An empty value deletes. */
  patchConnectorSettings: (name: string, changes: Readonly<Record<string, string>>) => send<ConnectorDetail>(`/connectors/${q(name)}/settings`, changes, "PATCH"),
  resetGeneral: (memory: boolean) => send<{ reset: boolean }>("/pai/reset", { memory }),
  runConnectorAction: (name: string, id: string) => send<{ message: string; thread?: string }>(`/connectors/${q(name)}/actions/${q(id)}`),
  routines: () => get<Routine[]>("/routines"),
  routineEvents: () => get<RoutineEvent[]>("/routines/events"),
  createRoutine: (input: RoutineFields) => send<Routine>("/routines", input),
  updateRoutine: (id: number, changes: RoutineFields) => send<Routine>(`/routines/${id}`, changes, "PATCH"),
  deleteRoutine: (id: number) => send(`/routines/${id}`, {}, "DELETE"),
  context: () => get<{ surfaces: string[]; items: ContextItem[] }>("/context"),
  saveContext: (name: string, text: string) => send("/context", { name, text }, "PUT"),
  resetContext: (name: string) => send(`/context?name=${q(name)}`, {}, "DELETE"),
  contextPrompt: (who: string) => get<{ text: string }>(`/context/prompt?who=${q(who)}`),
  createSkill: (name: string, description: string) => send("/skills", { name, description }),
  deleteSkill: (name: string) => send(`/skills/${q(name)}`, {}, "DELETE"),
  chatConfig: (session?: string) => get<ChatConfig>(session ? `/chat-config?session=${q(session)}` : "/chat-config"),
  tools: () => get<ToolProviders>("/tools"),
  patchTools: (change: { claudeSync?: boolean; server?: string; tool?: string; skill?: string; on?: boolean }) => track(request<ToolProviders>("PATCH", "/tools", change)),
  addServer: (server: { name: string; url: string; auth: "none" | "bearer" | "oauth"; token?: string; replaces?: string }) => track(request<{ name: string; tools: number } | { authorize: string }>("POST", "/tools/servers", server)),
  removeServer: (name: string) => track(request<ToolProviders>("DELETE", `/tools/servers/${q(name)}`, {})),
  spend: (days: number) => get<SpendReport>(`/spend?days=${days}`),
  snapshot: () => get<{ text: string }>("/snapshot"),
};

export const attachmentUrl = (name: string) => (/^(https?:|data:|blob:)/.test(name) ? name : `/attachments/${q(name)}`);
export const mapUrl = (lat: number, lon: number, width = 600, height = 220) => `/map?lat=${lat}&lon=${lon}&w=${width}&h=${height}`;
