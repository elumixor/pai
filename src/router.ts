import { config } from "./config.ts";
import { db, now } from "./db.ts";
import { all as allProjects, catalogText } from "./catalog.ts";
import { recentByProject } from "./sessions.ts";
import { logger } from "./log.ts";

const log = logger("router");

export type RouteAction = "new" | "continue" | "ask";

export interface Route {
  stage: "reply" | "explicit" | "sticky" | "model";
  action: RouteAction;
  project?: string;
  sessionId?: string;
  confidence: "high" | "medium" | "low";
  reason: string;
  /** Candidates offered to the user when action is "ask". */
  options?: { label: string; project: string; sessionId?: string }[];
  ms: number;
}

export interface RouteContext {
  /** Session that produced the message being replied to, if any. */
  replyToSessionId?: string;
}

const SCHEMA = {
  type: "object",
  properties: {
    project: { type: "string" },
    session: { type: "string" },
    action: { type: "string", enum: ["new", "continue", "ask"] },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    reason: { type: "string" },
  },
  required: ["project", "session", "action", "confidence", "reason"],
  additionalProperties: false,
} as const;

const SYSTEM = `You route a developer's free-form request to one of their local code projects.
Answer only by calling the StructuredOutput tool. Never ask questions, never use tools, be brief.

Rules:
- "project" must be an exact slug from the catalog, or "unknown" when no slug clearly fits.
- "session" is an exact short id from the live-session list when the request continues that session's work, otherwise "none".
- action "continue" requires a real session id. action "new" starts a fresh session. action "ask" means genuinely ambiguous.
- Prefer "continue" when the request refines, corrects, or follows up on what a live session is already doing.
- confidence "low" for a guess. Prefer action "ask" over a low-confidence guess.`;

export async function route(text: string, ctx: RouteContext = {}): Promise<Route> {
  const started = performance.now();
  const finish = (r: Omit<Route, "ms">): Route => {
    const route = { ...r, ms: Math.round(performance.now() - started) };
    record(text, route);
    return route;
  };

  // Stage 0a: an explicit reply to a session's message is unambiguous.
  if (ctx.replyToSessionId) {
    const s = recentByProject().find((r) => r.sessionId === ctx.replyToSessionId);
    return finish({
      stage: "reply",
      action: "continue",
      project: s?.project,
      sessionId: ctx.replyToSessionId,
      confidence: "high",
      reason: "reply to a message from this session",
    });
  }

  // Stage 0b: explicit "@slug" or "slug:" prefix.
  const explicit = matchExplicit(text);
  if (explicit) {
    return finish({
      stage: "explicit",
      action: "new",
      project: explicit,
      confidence: "high",
      reason: "project named explicitly",
    });
  }

  // Stage 1: cheap model over the catalog + live sessions.
  const projects = allProjects();
  const sessions = recentByProject().filter((s) => s.state !== "dead");
  const decision = await ask(text, projects.map((p) => p.slug), sessions);

  if (!decision) {
    return finish({
      stage: "model",
      action: "ask",
      confidence: "low",
      reason: "router unavailable",
      options: topCandidates(text, sessions),
    });
  }

  const project = projects.find((p) => p.slug === decision.project)?.slug;
  const session = sessions.find((s) => s.shortId === decision.session);

  if (decision.action === "ask" || decision.confidence === "low" || !project) {
    return finish({
      stage: "model",
      action: "ask",
      project,
      confidence: decision.confidence,
      reason: decision.reason,
      options: topCandidates(text, sessions),
    });
  }

  if (decision.action === "continue" && session) {
    return finish({
      stage: "model",
      action: "continue",
      project: session.project,
      sessionId: session.sessionId,
      confidence: decision.confidence,
      reason: decision.reason,
    });
  }

  return finish({
    stage: "model",
    action: "new",
    project,
    confidence: decision.confidence,
    reason: decision.reason,
  });
}

function matchExplicit(text: string): string | undefined {
  const m = /^\s*(?:@|#)?([\w.@/-]+)\s*[:>]\s*/.exec(text);
  const token = m?.[1]?.toLowerCase();
  if (!token) return undefined;
  for (const p of allProjects()) {
    if (p.slug.toLowerCase() === token || p.aliases.includes(token)) return p.slug;
  }
  return undefined;
}

function topCandidates(text: string, sessions: ReturnType<typeof recentByProject>) {
  const words = new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const scored = allProjects()
    .map((p) => ({
      project: p.slug,
      score: p.aliases.reduce((n, a) => n + (words.has(a) ? 2 : 0), 0) + (words.has(p.slug.toLowerCase()) ? 3 : 0),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  const options: NonNullable<Route["options"]> = scored.map((s) => ({ label: s.project, project: s.project }));
  for (const s of sessions.slice(0, 2)) {
    options.push({ label: `${s.project} · ${s.shortId} (continue)`, project: s.project, sessionId: s.sessionId });
  }
  return options;
}

interface Decision {
  project: string;
  session: string;
  action: RouteAction;
  confidence: "high" | "medium" | "low";
  reason: string;
}

async function ask(
  text: string,
  slugs: string[],
  sessions: ReturnType<typeof recentByProject>,
): Promise<Decision | undefined> {
  const catalog = catalogText();
  const sessionList = sessions.length
    ? sessions
        .map((s) => `- ${s.shortId} [${s.project}] ${s.state}: ${(s.title || s.lastResult).slice(0, 120)}`)
        .join("\n")
    : "(none)";

  const prompt = `Catalog:
${catalog}

Live sessions:
${sessionList}

Request: ${JSON.stringify(text)}`;

  try {
    const proc = Bun.spawn(
      [
        "claude",
        "-p",
        "--model",
        config.router.model,
        "--tools",
        "",
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "--mcp-config",
        '{"mcpServers":{}}',
        "--system-prompt",
        SYSTEM,
        "--no-session-persistence",
        "--output-format",
        "json",
        "--json-schema",
        JSON.stringify(SCHEMA),
        prompt,
      ],
      { stdout: "pipe", stderr: "pipe", cwd: config.devRoot },
    );
    const out = await new Response(proc.stdout).text();
    // --output-format json yields either the result object or an array of messages ending in it.
    const parsed = JSON.parse(out) as unknown;
    const result = (Array.isArray(parsed) ? parsed.find((m: any) => m?.type === "result") : parsed) as
      | { structured_output?: Decision; result?: string }
      | undefined;
    const decision =
      result?.structured_output ?? (result?.result ? (JSON.parse(result.result) as Decision) : undefined);
    if (decision) log.debug("routed", decision);
    void slugs;
    return decision;
  } catch (err) {
    log.warn("router call failed", (err as Error).message);
    return undefined;
  }
}

function record(text: string, route: Route) {
  db.prepare(
    `INSERT INTO routings (text, stage, project, session_id, action, confidence, reason, ms, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    text,
    route.stage,
    route.project ?? null,
    route.sessionId ?? null,
    route.action,
    route.confidence,
    route.reason,
    route.ms,
    now(),
  );
}
