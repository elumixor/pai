import { kv } from "../core/db.ts";

/**
 * How far he has read, per place: pai's chat, an agent's, a task's thread, the bell. One notion for
 * all of them — the instant of the newest thing he has actually seen — because the bell already
 * counted "newer than when you last looked", and a second notion would disagree with it.
 *
 * It lives on the box rather than in a browser, so the app, a reload and the phone agree.
 */

const KEY = "read_marks";

export type Marks = Readonly<Record<string, number>>;

export function marks(): Marks {
  try {
    return JSON.parse(kv.get(KEY) ?? "{}") as Marks;
  } catch {
    return {};
  }
}

/**
 * Only ever forward: two clients open at once must not undo each other, and a row seen on the phone
 * stays seen when the laptop catches up.
 */
export function mark(place: string, at: number): Marks {
  if (!place || !Number.isFinite(at)) return marks();
  const all = { ...marks() };
  if ((all[place] ?? 0) >= at) return all;
  all[place] = Math.floor(at);
  kv.set(KEY, JSON.stringify(all));
  return all;
}
