import { auth } from "./auth.svelte";
import { track } from "./progress.svelte";
import type {
  Agent,
  AgentInstructions,
  Ask,
  AuditEntry,
  Automation,
  Connector,
  ContextItem,
  DiskSession,
  Effort,
  LogMessage,
  ModuleInfo,
  Need,
  ProjectSummary,
  Routine,
  SessionSummary,
  SlashCommand,
  SpendReport,
  Status,
  TaskItem,
  TaskStatus,
  Transcript,
  Upload,
  Usage,
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
  projects: () => get<ProjectSummary[]>("/projects"),
  addProject: (url: string, name?: string) => send<ProjectSummary>("/projects", { url, name }),
  createContextProject: (name: string, about: string) => send<ProjectSummary>("/projects", { name, about }),
  models: () => get<{ latest: Record<string, { id: string; name: string }> }>("/models").then((r) => r.latest),
  commands: (session: string) => get<SlashCommand[]>(`/commands?session=${q(session)}`),
  rates: () => get<{ base: string; date: string; rates: Record<string, number>; currencies: string[] }>("/rates", true),
  readMarks: async () => (await get<{ marks: Record<string, number> }>("/reads", true)).marks ?? {},
  markRead: (place: string, at: number) => request("POST", "/reads", { place, at }),

  // ---- the staff: pai, its agents, the log, tasks, asks -------------------------------------
  pai: () => get<{ session: SessionSummary; thread: number | null; lastRotation: unknown }>("/pai"),
  sendPai: (text: string, images: readonly Upload[] = []) => send<SessionSummary>("/pai", { text, images }),
  agents: () => get<Agent[]>("/agents"),
  agent: (slug: string) => get<Agent & { children: Agent[]; tasks: TaskItem[] }>(`/agents/${slug}`),
  agentInstructions: (slug: string) => get<AgentInstructions>(`/agents/${slug}/instructions`),
  messageAgent: (slug: string, text: string, taskId?: number, images: readonly Upload[] = []) => send<LogMessage>(`/agents/${slug}/message`, { text, taskId, images }),
  configureAgent: (slug: string, changes: { bubble?: boolean; name?: string; parent?: string }) => send(`/agents/${slug}`, changes, "PATCH"),
  closeAgent: (slug: string) => send(`/agents/${slug}/close`, {}),
  messages: (agent: string, options: { before?: number; limit?: number; task?: number } = {}) =>
    get<LogMessage[]>(`/messages?${options.task ? `task=${options.task}` : `agent=${q(agent)}`}&limit=${options.limit ?? 100}${options.before ? `&before=${options.before}` : ""}`),
  /** The newest rows of the given kinds, whoever they are between: what the bell lists. */
  notices: (kinds: readonly string[], limit = 40) => get<LogMessage[]>(`/messages?kinds=${kinds.join(",")}&limit=${limit}`, true),
  message: (id: number) => get<LogMessage>(`/messages/${id}`),
  headline: (id: number) => get<{ headline: string | null; enabled: boolean }>(`/messages/${id}/headline`, true),
  tasks: async () => (await get<{ items?: TaskItem[] }>("/tasks")).items ?? [],
  /** Every task, closed ones included. */
  allTasks: async () => (await get<{ items?: TaskItem[] }>("/tasks?all=1")).items ?? [],
  sessions: () => get<{ items?: TaskItem[]; live: SessionSummary[]; recent: SessionSummary[] }>("/tasks"),
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
  routines: () => get<Routine[]>("/routines"),
  audit: (limit = 40) => get<AuditEntry[]>(`/audit?limit=${limit}`, true),

  // ---- threads: plain conversations and their transcripts ------------------------------------
  transcript: (session: string, limit = 300, cwd?: string) => get<Transcript[]>(`/transcript?session=${q(session)}&limit=${limit}${cwd ? `&cwd=${q(cwd)}` : ""}`),
  toolCall: (session: string, tool: string) => get<{ name: string; input: unknown; result?: string }>(`/transcript/tool?session=${q(session)}&tool=${q(tool)}`),
  threadsIn: (cwd: string, limit?: number) => get<DiskSession[]>(`/threads?cwd=${q(cwd)}${limit ? `&limit=${limit}` : ""}`),
  /** A new plain thread, on its own or in a project; its first message goes with it. */
  startThread: (text: string, images: readonly Upload[] = [], project?: string) => send<SessionSummary>("/task", { title: "", text, images, project, origin: project ? undefined : "general" }),
  sendThread: (id: string, text: string, images: readonly Upload[] = [], adopt?: { cwd?: string; title?: string }) => send("/send", { id, text, images, ...adopt }),
  stop: (id: string) => send("/stop", { id }),
  reconfigure: (id: string, changes: { model?: string | null; effort?: Effort | null }) => send("/reconfigure", { id, ...changes }),

  // ---- the pages about the daemon -------------------------------------------------------------
  modules: () => get<ModuleInfo[]>("/modules"),
  patchModule: (name: string, changes: Record<string, string>) => send(`/modules/${name}`, changes, "PATCH"),
  pollModule: (name: string) => send(`/modules/${name}/poll`, {}),
  connectors: () => get<Connector[]>("/connectors"),
  automations: () => get<Automation[]>("/automations"),
  createAutomation: (input: Partial<Automation>) => send("/automations", input),
  updateAutomation: (id: number, changes: Partial<Automation>) => send(`/automations/${id}`, changes, "PATCH"),
  deleteAutomation: (id: number) => send(`/automations/${id}`, {}, "DELETE"),
  context: () => get<{ surfaces: string[]; items: ContextItem[] }>("/context"),
  saveContext: (name: string, text: string) => send("/context", { name, text }, "PUT"),
  spend: (days: number) => get<SpendReport>(`/spend?days=${days}`),
  snapshot: () => get<{ text: string }>("/snapshot"),
  importSnapshot: (text: string) => send("/snapshot", { text }),
};

export const attachmentUrl = (name: string) => (/^(https?:|data:|blob:)/.test(name) ? name : `/attachments/${q(name)}`);
export const mapUrl = (lat: number, lon: number, width = 600, height = 220) => `/map?lat=${lat}&lon=${lon}&w=${width}&h=${height}`;
