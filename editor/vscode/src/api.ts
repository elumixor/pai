import * as vscode from "vscode";

export interface SessionSummary {
  readonly sessionId: string;
  readonly shortId: string;
  readonly kind: string;
  readonly title: string;
  readonly state: string;
  readonly cwd?: string;
  readonly project?: string;
  readonly queued?: number;
  readonly waiting?: boolean;
  readonly lastTool?: string;
  readonly turns?: number;
  readonly costUsd?: number;
}

export interface ProjectSummary {
  readonly slug: string;
  readonly path: string;
  readonly summary: string;
}

export interface TerminalSummary {
  readonly id: string;
  readonly cwd: string;
  readonly project?: string;
  readonly alive: boolean;
}

export interface PaiEvent {
  readonly kind: string;
  readonly ts: number;
  readonly sessionId?: string;
  readonly payload: Record<string, unknown>;
}

/** The daemon's base URL, read fresh so a settings change takes effect without a reload. */
export function baseUrl() {
  return (vscode.workspace.getConfiguration("pai").get<string>("baseUrl") ?? "").replace(/\/$/, "");
}

export function socketUrl(path: string) {
  return `${baseUrl().replace(/^http/, "ws")}${path}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl()}${path}`, init);
  if (!response.ok) throw new Error(`${path} → ${response.status} ${response.statusText}`);
  return (await response.json()) as T;
}

export const get = <T>(path: string) => request<T>(path);

export const post = <T>(path: string, body: unknown) =>
  request<T>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const tasks = () => get<{ live: SessionSummary[]; recent: SessionSummary[] }>("/tasks");
export const projects = () => get<ProjectSummary[]>("/projects");
export const terminals = () => get<TerminalSummary[]>("/terminals");
export const history = (session: string) => get<PaiEvent[]>(`/events?session=${session}`);

/**
 * The event stream as an async iterable. `fetch` is used rather than EventSource, which the
 * extension host does not have, so the frames are split by hand.
 */
export async function* follow(session: string | undefined, signal: AbortSignal) {
  const query = session ? `?follow=1&session=${session}` : "?follow=1";
  const response = await fetch(`${baseUrl()}/events${query}`, { signal });
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const data = frame.split("\n").find((line) => line.startsWith("data: "));
      if (data) yield JSON.parse(data.slice(6)) as PaiEvent;
    }
  }
}
