import { auth } from "./auth.svelte";
import type { Agent, Connector, ContextItem, LogMessage, Need, SessionSummary, TaskItem, Upload } from "./types";

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

const get = <T>(path: string) => request<T>("GET", path);
const post = <T>(path: string, body: unknown = {}) => request<T>("POST", path, body);

export const api = {
  pai: () => get<{ session: SessionSummary }>("/pai"),
  sendPai: (text: string, images: readonly Upload[]) => post<SessionSummary>("/pai", { text, images }),
  messages: (agent: string, options: { before?: number; limit?: number } = {}) =>
    get<LogMessage[]>(`/messages?agent=${encodeURIComponent(agent)}&limit=${options.limit ?? 80}${options.before ? `&before=${options.before}` : ""}`),
  agents: () => get<Agent[]>("/agents"),
  messageAgent: (slug: string, text: string, images: readonly Upload[]) => post(`/agents/${slug}/message`, { text, images }),
  needs: () => get<Need[]>("/needs"),
  answerNeed: (id: string, text: string) => post<{ answered: boolean }>("/needs/answer", { id, text }),
  answerQuestion: (session: string, text: string) => post("/answer", { id: session, text }),
  answerAsk: (id: number, text: string) => post(`/asks/${id}/answer`, { text }),
  sendDraft: (id: number, fields: Record<string, string>) => post(`/drafts/${id}/send`, fields),
  discardDraft: (id: number) => post(`/drafts/${id}/discard`, { why: "" }),
  tasks: () => get<{ items?: TaskItem[] }>("/tasks?all=1"),
  connectors: () => get<Connector[]>("/connectors"),
  context: () => get<{ surfaces: string[]; items: ContextItem[] }>("/context"),
  sessions: () => get<{ live: SessionSummary[] }>("/sessions"),
};

export const attachmentUrl = (name: string) => (/^(https?:|data:)/.test(name) ? name : `/attachments/${encodeURIComponent(name)}`);
