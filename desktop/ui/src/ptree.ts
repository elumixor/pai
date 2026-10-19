import { clear, el, fresh, motionMs } from "./dom.ts";
import { icon, type IconName } from "./icons.ts";

/**
 * The tree on the left: General, under it the agents (each nested under the one it reports to) and
 * under each the threads it is running, a row each. A row has its own icon, a spinner in its place while
 * it works, and after the name a hand with how many decisions wait on the user in it; a thread that is done turns into a check for a moment and
 * goes, and a thread that is not running is not in the tree at all. A row is only what it knows itself:
 * what a child holds never bubbles up.
 */
export interface TreeRow {
  readonly id: string;
  readonly label: string;
  readonly depth: number;
  /** A thread: it comes and goes with its work, and leaves with a check. */
  readonly thread?: boolean;
  readonly working: boolean;
  readonly waiting: number;
  readonly on: boolean;
  readonly title?: string;
  readonly icon: IconName;
  /** A row that cannot be opened: a folder that only groups the rows under it. */
  readonly inert?: boolean;
}

/** A finished thread stays as a check this long before its row leaves. */
const DONE_SHOWN_MS = 1400;

export interface SideTree {
  draw(rows: readonly TreeRow[]): void;
}

export function sideTree(root: HTMLElement, onOpen: (id: string) => void, arm?: (row: HTMLElement, id: string) => void, empty = "Nothing running."): SideTree {
  let last: readonly TreeRow[] = [];
  /** Threads that just finished, with where they stood, kept for one more draw. */
  const leaving = new Map<string, { row: TreeRow; after: string | undefined; until: number }>();
  let prune: ReturnType<typeof setTimeout> | undefined;

  const draw = (rows: readonly TreeRow[]) => {
    const now = Date.now();
    const ids = new Set(rows.map((r) => r.id));
    for (const [id, item] of leaving) if (ids.has(id) || item.until <= now) leaving.delete(id);
    // A thread that was there and is gone finished: it keeps its place, as a check, until the animation has run.
    if (last.length) {
      for (let i = 0; i < last.length; i += 1) {
        const row = last[i]!;
        if (row.thread && !ids.has(row.id) && !leaving.has(row.id)) leaving.set(row.id, { row, after: last.slice(0, i).reverse().find((r) => ids.has(r.id))?.id, until: now + DONE_SHOWN_MS });
      }
    }
    const before = new Set(last.map((r) => r.id));
    last = rows;
    const merged: (TreeRow & { done?: boolean })[] = [];
    const byAfter = new Map<string | undefined, TreeRow[]>();
    for (const item of leaving.values()) byAfter.set(item.after, [...(byAfter.get(item.after) ?? []), item.row]);
    const push = (after: string | undefined) => byAfter.get(after)?.forEach((row) => merged.push({ ...row, done: true }));
    push(undefined);
    for (const row of rows) {
      merged.push(row);
      push(row.id);
    }
    const nodes = merged.map((row) => {
      const mark = row.done ? icon("check", 14) : row.working ? el("span.spinner") : icon(row.icon, 14);
      const node = el(
        "button.ptree-row",
        { class: `ptree-row${row.on ? " on" : ""}${row.done ? " done" : ""}${row.inert ? " inert" : ""}${row.waiting ? " waiting" : ""}`, style: `--depth: ${row.depth}`, title: arm && !row.inert ? undefined : row.title, onclick: row.inert || row.done ? undefined : () => onOpen(row.id) },
        el("span.ptree-name", {}, mark, el("span.label", {}, row.label)),
        row.waiting && !row.done ? hand(row.waiting) : undefined,
      );
      if (arm && !row.inert) arm(node, row.id);
      return !row.done && !before.has(row.id) && before.size ? fresh(node) : node;
    });
    clear(root, ...(nodes.length ? nodes : [el("p.ptree-empty", {}, empty)]));
    clearTimeout(prune);
    if (leaving.size) prune = setTimeout(() => draw(last), DONE_SHOWN_MS + motionMs("base"));
  };
  return { draw };
}

/** After the name, on the right: a hand with how many decisions wait on the user in this row. */
const hand = (count: number) => el("span.ptree-hand", {}, icon("hand", 12), el("span", {}, String(count)));
