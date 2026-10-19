import { clear, el, fresh, motionMs } from "./dom.ts";
import { remember } from "./storage.ts";
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
/** Which nodes he has folded, kept across reloads: the tree is his to arrange. */
const FOLD_KEY = "pai.tree.folded";

function folded(): Set<string> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(FOLD_KEY) ?? "[]");
    return new Set(Array.isArray(stored) ? (stored as string[]) : []);
  } catch {
    return new Set();
  }
}

export interface SideTree {
  draw(rows: readonly TreeRow[]): void;
}

export function sideTree(root: HTMLElement, onOpen: (id: string) => void, arm?: (row: HTMLElement, id: string) => void, empty = "Nothing running."): SideTree {
  let last: readonly TreeRow[] = [];
  const shut = folded();
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
    /** A row has children when the row after it sits deeper. */
    const kids = merged.map((row, i) => (merged[i + 1]?.depth ?? -1) > row.depth);
    /**
     * What is drawn: everything except what sits under a folded row — unless the selection is in
     * there, in which case that branch stays open without being unfolded for good. A fold is his
     * arrangement of the tree, not a place for the current row to hide in.
     */
    const open = merged.map((row, i) => {
      if (!shut.has(row.id) || !kids[i]) return true;
      for (let j = i + 1; j < merged.length && merged[j]!.depth > row.depth; j += 1) if (merged[j]!.on) return true;
      return false;
    });
    const hidden = merged.map(() => false);
    for (let i = 0; i < merged.length; i += 1) {
      if (open[i] && !hidden[i]) continue;
      // Everything deeper than a closed (or hidden) row is out of sight with it.
      for (let j = i + 1; j < merged.length && merged[j]!.depth > merged[i]!.depth; j += 1) hidden[j] = true;
    }

    const toggle = (id: string) => {
      if (shut.has(id)) shut.delete(id);
      else shut.add(id);
      remember(FOLD_KEY, JSON.stringify([...shut]));
      draw(last);
    };

    const nodes = merged.map((row, index) => {
      if (hidden[index]) return undefined;
      const mark = row.done ? icon("check", 14) : row.working ? el("span.spinner") : icon(row.icon, 14);
      const node = el(
        "button.ptree-row",
        { class: `ptree-row${row.on ? " on" : ""}${row.done ? " done" : ""}${row.inert ? " inert" : ""}${row.waiting ? " waiting" : ""}`, style: `--depth: ${row.depth}`, title: arm && !row.inert ? undefined : row.title, onclick: row.inert || row.done ? undefined : () => onOpen(row.id) },
        kids[index]
          ? el("button.ptree-fold", {
              class: `ptree-fold${open[index] ? " open" : ""}`,
              type: "button",
              title: open[index] ? "fold" : "unfold",
              onclick: (event: Event) => {
                event.stopPropagation();
                toggle(row.id);
              },
            }, icon("chevron", 9))
          : el("span.ptree-fold.empty"),
        el("span.ptree-name", {}, mark, el("span.label", {}, row.label)),
        row.waiting && !row.done ? hand(row.waiting) : undefined,
      );
      if (arm && !row.inert) arm(node, row.id);
      return !row.done && !before.has(row.id) && before.size ? fresh(node) : node;
    });
    const drawn = nodes.filter((node): node is HTMLElement => Boolean(node));
    clear(root, ...(drawn.length ? drawn : [el("p.ptree-empty", {}, empty)]));
    clearTimeout(prune);
    if (leaving.size) prune = setTimeout(() => draw(last), DONE_SHOWN_MS + motionMs("base"));
  };
  return { draw };
}

/** After the name, on the right: a hand with how many decisions wait on the user in this row. */
const hand = (count: number) => el("span.ptree-hand", {}, icon("hand", 12), el("span", {}, String(count)));
