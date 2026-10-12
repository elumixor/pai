import { clear, el } from "./dom.ts";
import { icon } from "./icons.ts";

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

export function projectTree(root: HTMLElement, rows: readonly TreeRow[], onOpen: (id: string) => void, empty = "No projects yet.") {
  const groups: HTMLElement[] = [];
  for (const row of rows) {
    if (row.group || !groups.length) groups.push(el("div.ptree-group"));
    groups[groups.length - 1]!.append(
      el(
        "button.ptree-row",
        { class: `ptree-row${row.on ? " on" : ""}`, style: `--depth: ${row.depth}`, title: row.title, onclick: () => onOpen(row.id) },
        el("span.ptree-name", {}, row.working ? el("span.spinner", { title: "working now" }) : undefined, el("span.label", {}, row.label)),
        row.waiting ? el("span.ptree-hand", { title: `${row.waiting} waiting on you` }, icon("hand", 10), el("span", {}, String(row.waiting))) : undefined,
      ),
    );
  }
  clear(root, ...(groups.length ? groups : [el("p.ptree-empty", {}, empty)]));
}
