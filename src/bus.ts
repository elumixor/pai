import { EventEmitter } from "node:events";
import { db, now } from "./db.ts";
import { config } from "./config.ts";
import { logger } from "./log.ts";

const log = logger("bus");

export interface BuilderEvent {
  kind: string;
  sessionId?: string;
  project?: string;
  payload: Record<string, unknown>;
  ts: number;
}

class Bus extends EventEmitter {
  emitEvent(kind: string, payload: Record<string, unknown>, sessionId?: string, project?: string) {
    const event: BuilderEvent = { kind, sessionId, project, payload, ts: now() };
    db.prepare("INSERT INTO events (session_id, project, kind, payload, ts) VALUES (?, ?, ?, ?, ?)").run(
      sessionId ?? null,
      project ?? null,
      kind,
      JSON.stringify(payload),
      event.ts,
    );
    this.emit("event", event);
    void push(event);
    return event;
  }
}

export const bus = new Bus();
bus.setMaxListeners(50);

async function push(event: BuilderEvent) {
  const { url, secret } = config.dashboard;
  if (!url) return;
  try {
    await fetch(`${url.replace(/\/$/, "")}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    log.debug("dashboard push failed", (err as Error).message);
  }
}

export function recentEvents(sessionId?: string, limit = 100): BuilderEvent[] {
  const rows = sessionId
    ? (db
        .query("SELECT * FROM events WHERE session_id = ? ORDER BY id DESC LIMIT ?")
        .all(sessionId, limit) as Record<string, string | number>[])
    : (db.query("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(limit) as Record<string, string | number>[]);
  return rows
    .map((r) => ({
      kind: r.kind as string,
      sessionId: (r.session_id as string) ?? undefined,
      project: (r.project as string) ?? undefined,
      payload: JSON.parse(r.payload as string) as Record<string, unknown>,
      ts: r.ts as number,
    }))
    .reverse();
}
