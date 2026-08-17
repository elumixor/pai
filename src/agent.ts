import { ToolLoopAgent, tool, stepCountIs } from "ai";
import { z } from "zod";
import { config } from "./config.ts";
import { all as allProjects, get as getProject, refresh } from "./catalog.ts";
import { ensureLive, find, listAll, recentByProject, spawn } from "./sessions.ts";
import { bus, recentEvents, type BuilderEvent } from "./bus.ts";
import { history, remember } from "./chat.ts";
import { logger } from "./log.ts";

const log = logger("agent");

const INSTRUCTIONS = `You are builder: the operator of every Claude Code session on this machine.

You talk to one person — the developer who owns the projects under ~/dev. You are the layer
between what they say in chat and the coding agents that do the work.

What you do:
- Answer questions about what is running, what happened, and what you can do. Most messages
  are conversation, not work. Answer those directly, without calling tools you don't need.
- When they describe a bug or a feature, work out which project it belongs to and put a
  Claude Code session on it. Use list_projects when you are not sure of the exact slug.
- When a message follows up on work already in flight, send it to that session instead of
  starting a new one. Check list_sessions first. A new session starts with no memory of the
  old one, so continuing is almost always right for a refinement, correction, or question
  about work in progress.
- Requests about builder itself (this bot, routing, the dashboard) are work on the "builder"
  project like any other. You can change yourself.

How to behave:
- Be terse. This is a phone chat, not a report. A few lines is usually right.
- Never invent what a session did. Read it with session_output.
- Ask before spawning only when you genuinely cannot tell which project is meant. Otherwise
  pick the most likely one, spawn, and say which you chose so they can correct you.
- Prompts you pass to a session are read by a capable coding agent in that repo. Pass along
  the developer's intent and any detail they gave; don't pad it with instructions it doesn't
  need.
- Sessions run with permissions bypassed and edit repos directly. Destructive requests
  (deleting things, force pushing, dropping data) deserve a confirmation first.
- You can see sessions the developer started themselves in a terminal, but you cannot send
  them messages. Only sessions you spawned are yours to drive.

Formatting: plain text. No markdown headers, no bold, no bullet characters beyond "-".`;

const sessionIdArg = z.string().describe("session id, full or the 6-character short form");

const tools = {
  list_projects: tool({
    description: "Every project under ~/dev that can be worked on, with a one-line description.",
    inputSchema: z.object({}),
    execute: async () => allProjects().map((p) => ({ slug: p.slug, summary: p.summary })),
  }),

  describe_project: tool({
    description: "Path, description, and recent commits for one project.",
    inputSchema: z.object({ slug: z.string() }),
    execute: async ({ slug }) => {
      const project = getProject(slug);
      if (!project) return { error: `no project named ${slug}` };
      const log = await gitLog(project.path);
      const sessions = recentByProject(project.slug, 5);
      return { ...project, recentCommits: log, sessions };
    },
  }),

  list_sessions: tool({
    description:
      "Sessions builder owns (drivable), other Claude Code sessions running on this machine (read-only), " +
      "and recently finished sessions that can still be continued.",
    inputSchema: z.object({}),
    execute: async () => {
      const { owned, foreign } = await listAll();
      return {
        owned,
        recent: recentByProject(undefined, 10),
        others: foreign.map((f) => ({ cwd: f.cwd, kind: f.kind, name: f.name })),
      };
    },
  }),

  session_output: tool({
    description: "What a session actually did: its inputs, tool calls, and replies, oldest first.",
    inputSchema: z.object({ session: sessionIdArg, limit: z.number().optional() }),
    execute: async ({ session, limit }) => {
      const id = find(session)?.id ?? resolve(session);
      if (!id) return { error: `no session ${session}` };
      return recentEvents(id, limit ?? 40).map((e) => ({
        at: new Date(e.ts).toISOString().slice(11, 19),
        kind: e.kind.replace("session.", ""),
        detail: describeEvent(e.payload),
      }));
    },
  }),

  spawn_session: tool({
    description:
      "Start a new Claude Code session in a project and give it its first instruction. " +
      "Use only when no existing session is already on this work.",
    inputSchema: z.object({
      project: z.string().describe("project slug from list_projects"),
      prompt: z.string().describe("the instruction for the coding agent"),
    }),
    execute: async ({ project, prompt }) => {
      try {
        const session = spawn(project, prompt.slice(0, 80));
        session.send(prompt);
        return { started: true, session: session.shortId, project: session.project, cwd: session.cwd };
      } catch (err) {
        return { error: (err as Error).message };
      }
    },
  }),

  send_to_session: tool({
    description:
      "Send another turn to a session builder owns. Works even if its process exited — the session resumes with full context.",
    inputSchema: z.object({ session: sessionIdArg, message: z.string() }),
    execute: async ({ session, message }) => {
      const id = find(session)?.id ?? resolve(session);
      const live = id ? ensureLive(id) : undefined;
      if (!live) return { error: `no session ${session}` };
      live.send(message);
      return { sent: true, session: live.shortId, project: live.project, state: live.state };
    },
  }),

  kill_session: tool({
    description: "Stop a session's process. Its transcript survives and it can be continued later.",
    inputSchema: z.object({ session: sessionIdArg }),
    execute: async ({ session }) => {
      const live = find(session);
      if (!live) return { error: `no session ${session}` };
      live.kill();
      return { killed: live.shortId };
    },
  }),

  rescan_projects: tool({
    description: "Re-read ~/dev. Use after a repo is created, renamed, or moved.",
    inputSchema: z.object({}),
    execute: async () => ({ projects: refresh().length }),
  }),
};

export const agent = new ToolLoopAgent({
  model: config.agent.model,
  instructions: INSTRUCTIONS,
  tools,
  stopWhen: stepCountIs(12),
});

export interface ChatResult {
  text: string;
  steps: number;
}

/** One chat turn: history in, reply out, both persisted. */
export async function chat(text: string): Promise<ChatResult> {
  remember("user", text);
  try {
    const result = await agent.generate({ messages: history() });
    const reply = result.text.trim() || "(no reply)";
    remember("assistant", reply);
    log.info(`turn: ${result.steps.length} steps, ${result.usage.totalTokens} tokens`);
    return { text: reply, steps: result.steps.length };
  } catch (err) {
    log.error("turn failed", err);
    return { text: `agent error: ${(err as Error).message}`, steps: 0 };
  }
}

/**
 * What sessions report is part of the conversation, whatever frontend is attached —
 * otherwise "did it finish?" would depend on Telegram having been running.
 */
export function recordSessionActivity() {
  bus.on("event", (e: BuilderEvent) => {
    const tag = `${e.project} · ${e.sessionId?.slice(0, 6)}`;
    if (e.kind === "session.turn_end") {
      const text = String(e.payload.text ?? "").trim();
      if (text) remember("assistant", `[${tag}]\n${text}`.slice(0, 1500));
    } else if (e.kind === "session.exit" && e.payload.code !== 0) {
      remember("assistant", `[${tag}] session exited (code ${e.payload.code})`);
    }
  });
}

function resolve(idOrShort: string): string | undefined {
  return recentByProject(undefined, 100).find((s) => s.shortId === idOrShort || s.sessionId === idOrShort)?.sessionId;
}

function describeEvent(payload: Record<string, unknown>): string {
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
