/**
 * What an observer does with what it found. pai watches the channels it cannot test from the
 * inside — a release that never arrived, LinkedIn's two edges, the browser every module leans on —
 * and each of them wants the same thing from the task list: one row, raised when the fault appears,
 * its reason kept current, closed when the thing answers again.
 *
 * The missing half was what happens when a fault comes and goes: LinkedIn's did eleven times
 * between 12 and 15 October, each episode closed before the next began, and each new episode opened
 * a new row. Nothing was duplicated at any instant, and the result was still eleven identical tasks
 * — a watcher that floods is one he learns to scroll past, which costs exactly the thing it was
 * built for. So a fault returning reopens its own task and counts the return in its notes.
 */
import { logger } from "../core/log.ts";
import * as tasks from "./tasks.ts";

const log = logger("watch");

/** A fault that comes back within this window belongs to the task it already had. */
const SAME_FAULT_MS = 7 * 24 * 3600_000;

export interface Watcher {
  /** The one title this observer owns; it is how its task is found again. */
  readonly title: string;
  /** What he can do about it, the same whatever the reason. */
  readonly nextAction: string;
  /** Which observer raised it (`created_by`), so nothing else's task is ever reopened. */
  readonly by: string;
  readonly owner?: string;
}

/** The notes carry the history a single row would otherwise lose. */
function history(t: tasks.Task, reason: string) {
  const came = Number(/came back (\d+) times/.exec(t.notes ?? "")?.[1] ?? 0) + 1;
  const first = new Date(t.createdAt).toISOString().slice(0, 16).replace("T", " ");
  return `${reason}\n\n(first raised ${first} UTC, came back ${came} times — the fault comes and goes, so it keeps one task rather than one per episode.)`;
}

/**
 * `reason` = what is wrong, in his words; `undefined` = the thing answers, so anything open resolves.
 * An observer that could not ask passes neither: silence leaves the task as it is, because
 * "I could not ask" is not "it is fine".
 */
export function keep(w: Watcher, reason: string | undefined, nowMs = Date.now()) {
  const open = tasks.list({ open: true }).find((t) => t.title === w.title);
  if (!reason) {
    if (open) {
      log.info(`${w.by}: resolved, closing its task`);
      tasks.update(open.id, { status: "done", nextAction: "" });
    }
    return;
  }
  if (open) {
    const notes = open.notes?.includes(reason) ? open.notes : history(open, reason);
    if (open.notes !== notes) tasks.update(open.id, { notes, nextAction: w.nextAction });
    return;
  }
  log.warn(`${w.by}: ${reason}`);
  // Its own earlier task, closed when the fault last cleared: the same fault reopens it. One he
  // dropped himself is never reopened — dropping it is his answer, and raising it again overrules him.
  const mine = tasks
    .list({ status: "done" })
    .filter((t) => t.title === w.title && t.createdBy === w.by && nowMs - t.updatedAt < SAME_FAULT_MS)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (mine) {
    tasks.update(mine.id, { status: "inbox", nextAction: w.nextAction, notes: history(mine, reason) });
    return;
  }
  tasks.add({ title: w.title, status: "inbox", owner: w.owner ?? "pai-dev", createdBy: w.by, nextAction: w.nextAction, notes: reason });
}
