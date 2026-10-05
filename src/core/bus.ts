import { EventEmitter } from "node:events";
import { db, now } from "./db.ts";

export interface PaiEvent {
  kind: string;
  sessionId?: string;
  payload: Record<string, unknown>;
  ts: number;
}

/** Text deltas are high volume and only matter live; message rows have a table of their own. Neither goes in the event log. */
const EPHEMERAL = new Set(["session.delta", "message.new"]);

class Bus extends EventEmitter {
  emitEvent(kind: string, payload: Record<string, unknown>, sessionId?: string) {
    const event: PaiEvent = { kind, sessionId, payload, ts: now() };
    if (!EPHEMERAL.has(kind))
      db.prepare("INSERT INTO events (session_id, kind, payload, ts) VALUES (?, ?, ?, ?)").run(
        sessionId ?? null,
        kind,
        JSON.stringify(payload),
        event.ts,
      );
    this.emit("event", event);
    return event;
  }
}

export const bus = new Bus();
bus.setMaxListeners(100);

export function recentEvents(sessionId?: string, limit = 100): PaiEvent[] {
  const rows = sessionId
    ? (db
        .query("SELECT * FROM events WHERE session_id = ? ORDER BY id DESC LIMIT ?")
        .all(sessionId, limit) as Record<string, string | number>[])
    : (db.query("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(limit) as Record<string, string | number>[]);
  return rows
    .map((r) => ({
      kind: r.kind as string,
      sessionId: (r.session_id as string) ?? undefined,
      payload: JSON.parse(r.payload as string) as Record<string, unknown>,
      ts: r.ts as number,
    }))
    .reverse();
}

/** Resolves with the next event of `kind` for `sessionId`, or rejects after `timeoutMs`. */
export function waitFor(kind: string, sessionId: string, timeoutMs: number): Promise<PaiEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      bus.off("event", handler);
      reject(new Error(`timed out waiting for ${kind}`));
    }, timeoutMs);
    const handler = (e: PaiEvent) => {
      if (e.kind !== kind || e.sessionId !== sessionId) return;
      clearTimeout(timer);
      bus.off("event", handler);
      resolve(e);
    };
    bus.on("event", handler);
  });
}
