import { clear, el, stamp } from "./dom.ts";
import { icon, type IconName } from "./icons.ts";

/**
 * The tree on the left: one row per project, nested; a spinner while it works, a hand with
 * how many decisions wait on the user in it. A row is only what it knows itself: what a
 * child captured never bubbles up.
 */
export interface TreeRow {
  readonly id: string;
  readonly label: string;
  readonly depth: number;
  readonly working: boolean;
  readonly waiting: number;
  readonly on: boolean;
  readonly title?: string;
  /** The first row of a top-level project starts a new group. */
  readonly group: boolean;
}

export function projectTree(root: HTMLElement, rows: readonly TreeRow[], onOpen: (id: string) => void, arm?: (row: HTMLElement, id: string) => void, empty = "No projects yet.") {
  const groups: HTMLElement[] = [];
  for (const row of rows) {
    if (row.group || !groups.length) groups.push(el("div.ptree-group"));
    const node = el(
      "button.ptree-row",
      { class: `ptree-row${row.on ? " on" : ""}`, style: `--depth: ${row.depth}`, title: arm ? undefined : row.title, onclick: () => onOpen(row.id) },
      el("span.ptree-name", {}, row.working ? el("span.spinner") : undefined, el("span.label", {}, row.label)),
      row.waiting ? hand(row.waiting) : undefined,
    );
    arm?.(node, row.id);
    groups[groups.length - 1]!.append(node);
  }
  clear(root, ...(groups.length ? groups : [el("p.ptree-empty", {}, empty)]));
}

/** One conversation under the projects, on one line: what it is about, where it belongs and when it last moved. */
export interface ThreadRow {
  readonly id: string;
  readonly title: string;
  /** Where it belongs: its project (folder), else the agent's, else how it was started, else General. */
  readonly context: string;
  readonly at: number;
  readonly working: boolean;
  readonly waiting: number;
  readonly on: boolean;
  readonly icon: IconName;
  /** Finished or gone: still there, quieter. */
  readonly faint?: boolean;
  readonly tip?: string;
}

export function threadList(root: HTMLElement, rows: readonly ThreadRow[], onOpen: (id: string) => void, empty = "No threads yet.") {
  clear(
    root,
    ...(rows.length
      ? rows.map((row) =>
          el(
            "button.thread-row",
            { class: `thread-row${row.on ? " on" : ""}${row.faint ? " faint" : ""}`, title: [row.tip, stamp(row.at)].filter(Boolean).join("\n"), onclick: () => onOpen(row.id) },
            row.working ? el("span.spinner") : icon(row.icon, 10),
            el("span.label", {}, row.title),
            row.waiting ? hand(row.waiting) : undefined,
            el("span.thread-meta", {}, row.context),
            el("span.thread-when", {}, when(row.at)),
          ),
        )
      : [el("p.ptree-empty", {}, empty)]),
  );
}

/** "11:35" today, "Tue" this week, "Oct 7" before: the full instant is in the tooltip. */
function when(at: number) {
  const day = new Date(at);
  const today = new Date();
  if (day.toDateString() === today.toDateString()) return day.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  if (today.getTime() - at < 6 * 86_400_000) return day.toLocaleDateString(undefined, { weekday: "short" });
  return day.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const hand = (count: number) => el("span.ptree-hand", {}, icon("hand", 10), el("span", {}, String(count)));
