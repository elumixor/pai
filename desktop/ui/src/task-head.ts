import { el } from "./dom.ts";
import { icon, type IconName } from "./icons.ts";
import { markdown } from "./markdown.ts";
import type { TaskItem, TaskStatus } from "./types.ts";

/**
 * A task's own page, over the chat about it. A task with no thread used to show only an empty
 * conversation — "Nothing said here yet." — which says nothing about the task and reads as if the
 * work were under way. The task itself comes first: what it is, whose it is, what is waiting, and
 * a way to start it; the chat sits under it, quiet until there is something in it.
 */

const LABEL: Record<TaskStatus, string> = {
  inbox: "Not started",
  scheduled: "Scheduled",
  active: "Working",
  waiting_user: "Waiting on you",
  waiting_other: "Waiting",
  done: "Done",
  dropped: "Dropped",
};
const GLYPH: Record<TaskStatus, IconName> = { inbox: "circle", scheduled: "clock", active: "play", waiting_user: "hand", waiting_other: "hourglass", done: "circleCheck", dropped: "x" };

export interface TaskHeadContext {
  readonly ownerName: string;
  /** The owner is in a turn right now: only then does anything move. */
  readonly working: boolean;
  /** Ask the owner to start it: the chat's box, focused, with the task in hand. */
  readonly start: () => void;
}

export function taskHead(task: TaskItem, ctx: TaskHeadContext) {
  const meta = [LABEL[task.status], ctx.ownerName, task.due ? `due ${task.due}` : ""].filter(Boolean).join(" · ");
  const open = task.status !== "done" && task.status !== "dropped";
  return el(
    "section.task-head",
    {},
    el(
      "div.task-head-line",
      {},
      ctx.working && task.status === "active" ? el("span.spinner") : icon(GLYPH[task.status], 14),
      el("h2.task-title", {}, task.title),
      el("span.tag", {}, `#${task.id}`),
    ),
    el("div.task-meta", {}, meta),
    task.nextAction?.trim() ? el("div.task-next", {}, el("b", {}, "Next"), el("div.task-next-body", {}, markdown(task.nextAction))) : undefined,
    task.notes?.trim() ? el("div.task-notes", {}, markdown(task.notes)) : undefined,
    open && task.status === "inbox" ? el("button.opt.task-start", { onclick: ctx.start }, "Start it") : undefined,
  );
}
