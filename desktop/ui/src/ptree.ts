import { clear, el } from "./dom.ts";
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
  /** What the row is, drawn before its name when the spinner is not. */
  readonly icon?: IconName;
  /** A row with rows under it: whether they show; a click on the chevron flips it. */
  readonly fold?: "open" | "closed";
  /** Done or closed: still there, quieter. */
  readonly faint?: boolean;
}

export function projectTree(root: HTMLElement, rows: readonly TreeRow[], onOpen: (id: string) => void, arm?: (row: HTMLElement, id: string) => void, empty = "No projects yet.", onFold?: (id: string) => void) {
  const groups: HTMLElement[] = [];
  for (const row of rows) {
    if (row.group || !groups.length) groups.push(el("div.ptree-group"));
    const fold = row.fold
      ? el("span.ptree-fold", { class: `ptree-fold ${row.fold}`, title: row.fold === "open" ? "fold" : "unfold", onclick: (event: Event) => (event.stopPropagation(), onFold?.(row.id)) }, icon("chevron", 8))
      : undefined;
    const node = el(
      "button.ptree-row",
      { class: `ptree-row${row.on ? " on" : ""}${row.faint ? " faint" : ""}`, style: `--depth: ${row.depth}`, title: arm ? undefined : row.title, onclick: () => onOpen(row.id) },
      el("span.ptree-name", {}, row.working ? el("span.spinner") : row.icon ? icon(row.icon, 10) : undefined, el("span.label", {}, row.label), fold),
      row.waiting ? el("span.ptree-hand", {}, icon("hand", 10), el("span", {}, String(row.waiting))) : undefined,
    );
    arm?.(node, row.id);
    groups[groups.length - 1]!.append(node);
  }
  clear(root, ...(groups.length ? groups : [el("p.ptree-empty", {}, empty)]));
}
