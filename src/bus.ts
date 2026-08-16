import { EventEmitter } from "node:events";
import { db, now } from "./db.ts";

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
    return event;
  }
}

export const bus = new Bus();
bus.setMaxListeners(50);

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
