import { auth } from "./auth.svelte";
import type { PaiEvent } from "./types";

const RETRY_MS = 3000;

/**
 * The daemon's event stream, read with `fetch` so it carries the same Authorization header as every other request
 * (an EventSource cannot). Reconnects by itself; `onReconnect` lets a view re-read what it missed while away.
 */
export function follow(query: Record<string, string>, onEvent: (event: PaiEvent) => void, onReconnect: () => void = () => {}) {
  const controller = new AbortController();
  let connectedOnce = false;

  const run = async () => {
    while (!controller.signal.aborted) {
      try {
        const response = await fetch(`/events?${new URLSearchParams({ follow: "1", ...query })}`, {
          headers: await auth.header(),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) throw new Error(`events: ${response.status}`);
        if (connectedOnce) onReconnect();
        connectedOnce = true;
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            const data = frame
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n");
            if (data) onEvent(JSON.parse(data) as PaiEvent);
          }
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        console.warn("[events] stream dropped, reconnecting", error);
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    }
  };

  void run();
  return () => controller.abort();
}
