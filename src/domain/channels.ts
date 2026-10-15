import { logger } from "../core/log.ts";
import { keep, type Image } from "./attachments.ts";

/**
 * Terminals that can be written to: each `claude` started with the pai channel (`pai channel`)
 * holds a stream here for the conversation it is in, and a message for that conversation —
 * typed in Paigram, say — goes down the stream into the terminal as if typed there.
 */

const log = logger("channels");
const enc = new TextEncoder();
const open = new Map<string, Set<(data: string) => void>>();

/** True when a terminal took it. The newest connection for a conversation wins; there is rarely more than one. */
export function deliver(sessionId: string, text: string, images: readonly Image[] = []): boolean {
  const writers = open.get(sessionId);
  const newest = writers ? [...writers].at(-1) : undefined;
  if (!newest) return false;
  // The terminal may be on another machine: the pictures go down the stream, named as the daemon keeps them.
  newest(JSON.stringify({ text, images: images.map((image) => ({ ...image, name: keep(image) })) }));
  log.info(`${sessionId.slice(0, 6)}: delivered to its terminal`);
  return true;
}

export const connected = (sessionId: string) => (open.get(sessionId)?.size ?? 0) > 0;

/** The stream a terminal's channel reads, as server-sent events. */
export function stream(sessionId: string): Response {
  let write: (data: string) => void = () => {};
  let ping: ReturnType<typeof setInterval>;
  const body = new ReadableStream({
    start(controller) {
      write = (data) => {
        try {
          controller.enqueue(enc.encode(`data: ${data}\n\n`));
        } catch {
          /* the terminal went away between messages */
        }
      };
      const writers = open.get(sessionId) ?? new Set();
      writers.add(write);
      open.set(sessionId, writers);
      log.info(`${sessionId.slice(0, 6)}: terminal connected`);
      controller.enqueue(enc.encode(": connected\n\n"));
      ping = setInterval(() => {
        try {
          controller.enqueue(enc.encode(": ping\n\n"));
        } catch {
          /* closed; cancel clears this */
        }
      }, 15_000);
    },
    cancel() {
      clearInterval(ping);
      const writers = open.get(sessionId);
      writers?.delete(write);
      if (writers?.size === 0) open.delete(sessionId);
      log.info(`${sessionId.slice(0, 6)}: terminal gone`);
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
}
