import { allTasks, follow } from "./api.ts";
import { clear, el, fresh } from "./dom.ts";
import { icon, type IconName } from "./icons.ts";
import { remember } from "./storage.ts";
import type { TaskItem, TaskStatus } from "./types.ts";

/**
 * An agent's desk: its tasks as a list, grouped by state, the way a Notion list view groups by
 * status — a fold triangle, the state's name and how many over each group, a row per task, with
 * the sub-agents' tasks on it too (a pill says whose) and the due date as a pill. The four states
 * are the sidebar peek's; only the ones with tasks are drawn, done folded until opened.
 */

/** The four states the sidebar's peek counts, in the same words: a task is in exactly one. */
type Group = "scheduled" | "working" | "decision" | "done";
const GROUPS: readonly { readonly id: Group; readonly label: string; readonly statuses: readonly TaskStatus[]; readonly folded?: boolean }[] = [
  { id: "scheduled", label: "Scheduled", statuses: ["inbox", "scheduled"] },
  { id: "working", label: "Working", statuses: ["active", "waiting_other"] },
  { id: "decision", label: "Decision", statuses: ["waiting_user"] },
  { id: "done", label: "Done", statuses: ["done", "dropped"], folded: true },
];
/** The row's mark for a task in each status; a spinner replaces it while the owner is at work on it. */
const MARK: Record<TaskStatus, IconName> = { waiting_user: "hand", active: "play", inbox: "circle", scheduled: "clock", waiting_other: "hourglass", done: "circleCheck", dropped: "x" };
const FOLD_KEY = "pai.tasks.folded";

export interface AgentTasksContext {
  /** The agent whose desk this is, or one of the sub-agents working under it: its tasks are on this desk too. */
  readonly under: (owner: string) => boolean;
  readonly nameOf: (owner: string) => string;
  readonly working: (owner: string) => boolean;
  readonly openTask: (id: number) => void;
  readonly selected: () => number | undefined;
  /** A new task is asked for in words: the chat with the agent, with the box focused. */
  readonly newTask: () => void;
}

const DAY_MS = 86_400_000;
/** A due date as a person says it: Today, Tomorrow, Yesterday, a weekday within the week, else the date. */
function dueLabel(due: string) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const [y, m, d] = due.split("-").map(Number);
  const day = y && m && d ? new Date(y, m - 1, d) : new Date(due);
  if (Number.isNaN(day.getTime())) return due;
  const days = Math.round((day.getTime() - today.getTime()) / DAY_MS);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  if (days > 1 && days < 7) return day.toLocaleDateString(undefined, { weekday: "long" });
  return day.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(day.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) });
}
const OPEN: readonly TaskStatus[] = ["inbox", "scheduled", "active", "waiting_other", "waiting_user"];
const isLate = (t: TaskItem) => Boolean(t.due && OPEN.includes(t.status) && new Date(t.due).getTime() < Date.now() - DAY_MS);

export function agentTasks(slug: string, ctx: AgentTasksContext) {
  const node = el("section.agent-tasks");
  const body = el("div.agent-tasks-body");
  const add = el("button.desk-new", { title: "ask for a task in words", onclick: () => ctx.newTask() }, icon("plus", 12), el("span", {}, "New task"));
  clear(node, body, add);
  let tasks: TaskItem[] = [];
  let folded = new Set<Group>(GROUPS.filter((g) => g.folded).map((g) => g.id));
  try {
    const kept = localStorage.getItem(`${FOLD_KEY}.${slug}`);
    if (kept) folded = new Set(JSON.parse(kept) as Group[]);
  } catch {
    /* a browser without storage folds the defaults */
  }
  const keepFolds = () => remember(`${FOLD_KEY}.${slug}`, JSON.stringify([...folded]));
  const shown = new Set<number>();

  const row = (t: TaskItem) => {
    const busy = t.status === "active" && ctx.working(t.owner);
    const node = el(
      "button.desk-row",
      { class: `desk-row status-${t.status}${t.id === ctx.selected() ? " on" : ""}`, title: t.nextAction || undefined, onclick: () => ctx.openTask(t.id) },
      busy ? el("span.spinner") : icon(MARK[t.status], 14),
      el("span.desk-row-title", {}, t.title),
      t.owner !== slug ? el("span.desk-pill.agent", { title: "whose task it is" }, ctx.nameOf(t.owner)) : undefined,
      t.due ? el("span.desk-pill.due", { class: `desk-pill due${isLate(t) ? " late" : ""}`, title: t.due }, dueLabel(t.due)) : undefined,
    );
    const isNew = shown.size > 0 && !shown.has(t.id);
    shown.add(t.id);
    return isNew ? fresh(node) : node;
  };

  const draw = () => {
    const mine = tasks.filter((t) => ctx.under(t.owner)).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const groups = GROUPS.map((g) => ({ ...g, items: mine.filter((t) => g.statuses.includes(t.status)) })).filter((g) => g.items.length);
    clear(
      body,
      ...(groups.length ? [] : [el("p.desk-empty", {}, "No tasks.")]),
      ...groups.map((g) => {
        const items = g.items;
        const open = !folded.has(g.id);
        const head = el(
          "button.desk-group-head",
          {
            class: `desk-group-head${open ? " open" : ""}`,
            onclick: () => {
              if (open) folded.add(g.id);
              else folded.delete(g.id);
              keepFolds();
              draw();
            },
          },
          icon("chevron", 11),
          el("span", {}, g.label),
          el("span.desk-group-count", {}, String(items.length)),
        );
        return el("div.desk-group", { class: `desk-group${open ? "" : " folded"}` }, head, open && items.length ? el("div.desk-group-rows", {}, ...items.map(row)) : undefined);
      }),
    );
  };

  const load = () =>
    allTasks()
      .then((all) => ((tasks = all), draw()))
      .catch(() => draw());
  void load();
  const stop = follow(
    undefined,
    (event) => {
      if (event.kind !== "task.added" && event.kind !== "task.updated" && event.kind !== "agent.changed" && event.kind !== "agent.created") return;
      if (event.kind === "agent.changed" || event.kind === "agent.created") return void draw();
      const t = event.payload as unknown as TaskItem;
      const i = tasks.findIndex((x) => x.id === t.id);
      if (i >= 0) tasks[i] = { ...tasks[i]!, ...t };
      else tasks.push(t);
      draw();
    },
    { replay: false },
  );

  return { node, redraw: draw, dispose: stop };
}
