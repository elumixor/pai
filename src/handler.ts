import { route, type Route } from "./router.ts";
import { ensureLive, spawn } from "./sessions.ts";
import { logger } from "./log.ts";

const log = logger("handler");

export interface Incoming {
  text: string;
  replyToSessionId?: string;
}

export interface Handled {
  kind: "spawned" | "continued" | "ask" | "error";
  text: string;
  sessionId?: string;
  shortId?: string;
  project?: string;
  route?: Route;
  options?: { label: string; project: string; sessionId?: string }[];
}

/** Turns one free-form user message into session work. Frontend-agnostic. */
export async function handle(msg: Incoming): Promise<Handled> {
  const decision = await route(msg.text, { replyToSessionId: msg.replyToSessionId });
  log.info(`route[${decision.stage}] -> ${decision.action} ${decision.project ?? "?"} (${decision.ms}ms)`);

  if (decision.action === "ask") {
    return {
      kind: "ask",
      text: `Which project? (${decision.reason})`,
      route: decision,
      options: decision.options ?? [],
    };
  }

  return dispatch(msg.text, decision.project!, decision.sessionId, decision);
}

/** Sends `text` to a specific project/session, creating the session when needed. */
export function dispatch(text: string, project: string, sessionId?: string, decision?: Route): Handled {
  try {
    if (sessionId) {
      const session = ensureLive(sessionId);
      if (session) {
        session.send(text);
        return {
          kind: "continued",
          text: `→ ${session.project} · ${session.shortId}`,
          sessionId: session.id,
          shortId: session.shortId,
          project: session.project,
          route: decision,
        };
      }
      log.warn(`session ${sessionId} could not be revived; starting a new one`);
    }
    const session = spawn(project, text.slice(0, 80));
    session.send(text);
    return {
      kind: "spawned",
      text: `▶ new session in ${session.project} · ${session.shortId}`,
      sessionId: session.id,
      shortId: session.shortId,
      project: session.project,
      route: decision,
    };
  } catch (err) {
    return { kind: "error", text: (err as Error).message, route: decision };
  }
}
