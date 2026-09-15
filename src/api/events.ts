import { bus, recentEvents, type PaiEvent } from "../core/bus.ts";

export interface StreamOptions {
  /** Text deltas are high volume; a client rendering a thread asks for them. */
  readonly deltas?: boolean;
  /** The last events before the connection, so a dashboard has something to show; a thread view already has the transcript. */
  readonly replay?: boolean;
}

/** The daemon's event stream as server-sent events, optionally narrowed to one session. */
export function events(sessionId?: string, options: StreamOptions = {}) {
  const enc = new TextEncoder();
  let write: (e: PaiEvent) => void = () => {};
  let ping: ReturnType<typeof setInterval>;

  const stream = new ReadableStream({
    start(controller) {
      write = (e) => {
        if (sessionId && e.sessionId !== sessionId) return;
        if (e.kind === "session.delta" && !options.deltas) return;
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          /* client went away between events */
        }
      };
      if (options.replay !== false) for (const e of recentEvents(sessionId, 50)) write(e);
      bus.on("event", write);
      ping = setInterval(() => {
        try {
          controller.enqueue(enc.encode(": ping\n\n"));
        } catch {
          /* same */
        }
      }, 15000);
    },
    cancel() {
      clearInterval(ping);
      bus.off("event", write);
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}
