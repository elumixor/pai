import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Session, SessionKind } from "./session.ts";
import { all as allProjects, get as getProject, refresh } from "./catalog.ts";
import { bus, recentEvents } from "../core/bus.ts";
import * as sessions from "./sessions.ts";
import { cost as hostingCost } from "./hetzner.ts";
import { roleOf, staffTools } from "./staff-tools.ts";
import * as audit from "./audit.ts";

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const taskArg = z.string().describe("thread id, full or the 6-character short form");

export interface SessionRef {
  session?: Session;
}

/**
 * In-process MCP server. One instance per session, so the tools know who is calling; the
 * session arrives through a ref because pre-warmed processes are built before it exists.
 */
export function paiTools(kind: SessionKind, ref: SessionRef, agent?: string) {
  const self = () => {
    if (!ref.session) throw new Error("tool called before its session was bound");
    return ref.session;
  };
  const common = [
    tool(
      "progress",
      "Post a short interim note to the user in this session's chat, before the turn ends. Use sparingly: one line when a long step finished.",
      { text: z.string().max(500) },
      async ({ text }) => {
        bus.emitEvent("session.progress", { text }, self().id);
        return ok({ posted: true });
      },
    ),
    tool(
      "hosting_cost",
      "What the host costs per month, priced from the Hetzner account itself. The Claude usage the sessions spend is billed separately and is not in here.",
      {},
      async () => ok(await hostingCost().catch((err: Error) => ({ error: err.message }))),
    ),
    tool(
      "audit",
      "What the sessions did outside the daemon, newest first: emails and messages sent, posts, calendar and document writes, clicks in signed-in sites — with the full input and whether it went through. Use it to answer \"did we send X\", \"what went to Y\", or before repeating something that may already have gone out.",
      {
        agent: z.string().optional().describe("one agent's slug; omit for everyone"),
        q: z.string().optional().describe("words to find in the call's summary or input, e.g. a name or an address"),
        days: z.number().optional().describe("only the last this many days"),
        limit: z.number().max(200).optional(),
      },
      async ({ agent, q, days, limit }) => ok(audit.list({ agent, search: q, since: days ? Date.now() - days * 86_400_000 : undefined, limit: limit ?? 30 })),
    ),
    tool(
      "list_projects",
      "The user's projects: every git repo under the dev root, plus the context projects (a directory with its own instructions and memory, for work that is not code — travel, hiring).",
      {},
      async () => ok(allProjects().map((p) => ({ slug: p.slug, kind: p.kind, summary: p.summary }))),
    ),
    tool(
      "describe_project",
      "Path, description, and recent commits for one project.",
      { slug: z.string() },
      async ({ slug }) => {
        const project = getProject(slug);
        if (!project) return ok({ error: `no project named ${slug}` });
        return ok({ ...project, recentCommits: await gitLog(project.path) });
      },
    ),
    tool("rescan_projects", "Re-read the dev root. Use after a repo is created, renamed, or moved.", {}, async () =>
      ok({ projects: refresh().length }),
    ),
  ];

  const tasks = [
    tool(
      "start_thread",
      "Start a thread in its own Telegram topic and its own context, running in parallel; it reports back here when it finishes. Give it a short title (topic name) and a complete prompt: everything the task needs, since it does not see this conversation. Pass a project slug for coding work in one of the user's repos — the `pai` project is this assistant's own code.",
      {
        title: z.string().max(60).describe("short topic name, e.g. 'Find game designer'"),
        prompt: z.string().describe("the full instruction for the thread"),
        project: z.string().optional().describe("project slug from list_projects: a repo for coding work, a context project for work that has its own voice and memory"),
      },
      async ({ title, prompt, project }) => {
        try {
          const me = self();
          const s = sessions.spawnTask({ title, project, parent: me.id });
          s.send(prompt);
          return ok({ started: true, task: s.shortId, title: s.title, kind: s.kind, project: s.project });
        } catch (err) {
          return ok({ error: (err as Error).message });
        }
      },
    ),
    tool(
      "send_to_thread",
      "Send a follow-up, correction, or answer to a running or finished thread. It resumes with full context.",
      { task: taskArg, message: z.string() },
      async ({ task, message }) => {
        const s = resolve(task);
        if (!s) return ok({ error: `no task ${task}` });
        s.send(message);
        return ok({ sent: true, task: s.shortId, title: s.title, state: s.state });
      },
    ),
    tool(
      "list_threads",
      "Threads: running, waiting for the user, and recently finished, with their last result.",
      {},
      async () =>
        ok(
          sessions.recent(15).map((t) => ({
            task: t.shortId,
            title: t.title,
            kind: t.kind,
            project: t.project ?? undefined,
            state: t.state,
            waiting: sessions.find(t.sessionId)?.pending ? true : undefined,
            lastResult: t.lastResult.slice(0, 300),
            costUsd: Number(t.costUsd.toFixed(3)),
            lastActivity: new Date(t.lastActivity).toISOString(),
          })),
        ),
    ),
    tool(
      "thread_output",
      "What a thread actually did: its inputs, tool calls, and replies, oldest first.",
      { task: taskArg, limit: z.number().optional() },
      async ({ task, limit }) => {
        const id = sessions.find(task)?.id ?? sessions.resolveId(task);
        if (!id) return ok({ error: `no task ${task}` });
        return ok(
          recentEvents(id, limit ?? 40).map((e) => ({
            at: new Date(e.ts).toISOString().slice(11, 19),
            kind: e.kind.replace("session.", ""),
            detail: describe(e.payload),
          })),
        );
      },
    ),
    tool(
      "stop_thread",
      "Interrupt a running thread. Its transcript survives and it can be continued later with send_to_thread.",
      { task: taskArg },
      async ({ task }) => {
        const s = sessions.find(task);
        if (!s) return ok({ error: `no live task ${task}` });
        await s.interrupt();
        return ok({ interrupted: s.shortId });
      },
    ),
  ];

  return createSdkMcpServer({
    name: "pai",
    version: "1.0.0",
    // pai's own tools are how its staff works at all; behind tool search the model reaches for built-ins instead.
    alwaysLoad: Boolean(agent),
    // Threads are a plain conversation's; pai reads them (terminal work) but hands work off as agents.
    tools: [...common, ...(roleOf(agent) === "thread" ? tasks : roleOf(agent) === "orchestrator" ? tasks.filter((t) => !STARTS_THREADS.has(t.name)) : []), ...staffTools(agent)],
  });
}

const STARTS_THREADS = new Set(["start_thread", "send_to_thread"]);

function resolve(idOrShort: string): Session | undefined {
  const id = sessions.find(idOrShort)?.id ?? sessions.resolveId(idOrShort);
  return id ? sessions.ensureLive(id) : undefined;
}

function describe(payload: Record<string, unknown>): string {
  if (typeof payload.text === "string") return payload.text.replace(/\s+/g, " ").slice(0, 400);
  if (payload.name) return `${payload.name} ${payload.summary ?? ""}`;
  return JSON.stringify(payload).slice(0, 200);
}

async function gitLog(cwd: string): Promise<string[]> {
  try {
    const proc = Bun.spawn(["git", "log", "-5", "--format=%s"], { cwd, stdout: "pipe", stderr: "ignore" });
    return (await new Response(proc.stdout).text()).trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}
