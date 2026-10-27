import { api } from "./api";

/**
 * How far he has read, held by the daemon so the app, a reload and the phone agree. One notion for every place —
 * the instant of the newest thing he has seen — which is the one the bell counts by. A mark only moves forward, and
 * is written through at most once a second: reading is a continuous act and does not deserve a request per row.
 */
const WRITE_EVERY_MS = 1000;

const local: Record<string, number> = {};
let pending: Record<string, number> = {};
let timer: ReturnType<typeof setTimeout> | undefined;
let loaded: Promise<void> | undefined;

/** The marks as the daemon has them; a failure leaves what this session knows. */
export function loadReads() {
  loaded ??= api
    .readMarks()
    .then((all) => {
      for (const [place, at] of Object.entries(all)) local[place] = Math.max(local[place] ?? 0, at);
    })
    .catch((error) => console.warn("[reads] marks unavailable", error));
  return loaded;
}

export const readAt = (place: string) => local[place] ?? 0;

export function markRead(place: string, at: number) {
  if (!place || !Number.isFinite(at) || at <= readAt(place)) return;
  local[place] = at;
  pending[place] = at;
  timer ??= setTimeout(flush, WRITE_EVERY_MS);
}

function flush() {
  timer = undefined;
  const writing = pending;
  pending = {};
  for (const [place, at] of Object.entries(writing)) void api.markRead(place, at).catch((error) => console.warn("[reads] mark not written", error));
}

/** On the way out of a page: what is known now goes, rather than waiting for a timer that will not fire. */
export function flushReads() {
  if (timer) clearTimeout(timer);
  flush();
}
