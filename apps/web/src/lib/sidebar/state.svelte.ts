import { menus } from "../ui/menu-state.svelte";
import { mover } from "./move.svelte";
import type { TreeNode } from "./tree";
import { recall, remember } from "../storage";

const NARROW = "(max-width: 767px)";
const WIDTH_KEY = "pai.sidebar.width";
const EXPANDED_KEY = "pai.tree.expanded";
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 480;
/** Dragged narrower than this, the sidebar collapses. */
export const SIDEBAR_COLLAPSE = 140;

/**
 * The sidebar, as Keep's: open on a wide screen, closed on a phone, where it floats over the chat and closes after a
 * pick. Which rows are unfolded is his arrangement of the tree, kept across reloads.
 */
class Sidebar {
  narrow = $state(false);
  open = $state(true);
  width = $state(260);
  expanded = $state(new Set<string>(recall<string[]>(EXPANDED_KEY, [])));
  /** The tree drawn now: what a drop checks it would not put a row under itself. */
  roots = $state.raw<readonly TreeNode[]>([]);

  constructor() {
    const saved = Number(recall<number>(WIDTH_KEY, 0));
    if (saved) this.resize(saved);
    if (typeof matchMedia !== "function") return;
    const media = matchMedia(NARROW);
    this.narrow = media.matches;
    this.open = !media.matches;
    media.addEventListener("change", () => {
      this.narrow = media.matches;
      this.open = !media.matches;
    });
  }

  resize(width: number) {
    this.width = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, width));
  }

  saveWidth() {
    remember(WIDTH_KEY, String(this.width));
  }

  toggle() {
    this.open = !this.open;
  }

  /** After navigating: a phone's sidebar gets out of the way. */
  settle() {
    if (this.narrow) this.open = false;
  }

  set(id: string, open: boolean) {
    if (this.expanded.has(id) === open) return;
    const next = new Set(this.expanded);
    if (open) next.add(id);
    else next.delete(id);
    this.expanded = next;
    remember(EXPANDED_KEY, JSON.stringify([...next]));
  }

  /** Unfolds every row above one, so it shows. */
  reveal(ids: readonly string[]) {
    for (const id of ids) this.set(id, true);
  }
}

export const sidebar = new Sidebar();

/**
 * The rows picked in the tree, Keep's way: ⌘-click adds or drops one, ⇧-click picks the run from the anchor, and a
 * drag or `m` moves them all. `last` is the row picked last, drawn a shade deeper.
 */
class Selection {
  selected = $state(new Set<string>());
  anchor = $state<string | null>(null);
  last = $state<string | null>(null);
  /** Rows being dragged: a drop puts them under the row it lands on. */
  dragging = $state<readonly string[] | null>(null);

  has(id: string) {
    return this.selected.has(id);
  }

  toggle(id: string) {
    const next = new Set(this.selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.selected = next;
    this.anchor = id;
    this.last = next.has(id) ? id : null;
  }

  /** Picks every visible row between the anchor and `id`. */
  range(id: string, from: string | null) {
    // The rows in tree order, an "N more" standing for the rows it hides.
    const rows = [...document.querySelectorAll<HTMLElement>('[role="tree"] [role="treeitem"][data-tree-id], [role="tree"] [data-tree-more]')].flatMap((r) =>
      r.dataset.treeMore ? r.dataset.treeMore.split(" ") : r.dataset.treeId === "pai" ? [] : [r.dataset.treeId!],
    );
    const start = from ? rows.indexOf(from) : -1;
    const end = rows.indexOf(id);
    if (end < 0) return;
    const [a, b] = start < 0 ? [end, end] : [Math.min(start, end), Math.max(start, end)];
    this.selected = new Set(rows.slice(a, b + 1));
    this.anchor ??= from ?? id;
    this.last = id;
  }

  pick(ids: readonly string[]) {
    this.selected = new Set([...this.selected, ...ids]);
  }

  unpick(ids: readonly string[]) {
    const next = new Set(this.selected);
    for (const id of ids) next.delete(id);
    this.selected = next;
  }

  /** Whether every row an "N more" hides is picked. */
  allPicked(hidden: readonly string[]) {
    return hidden.length > 0 && hidden.every((id) => this.selected.has(id));
  }

  /**
   * A click on "N more" (`key` names it): ⌘ picks or drops the rows it hides, ⇧ runs the range to them and takes them
   * all. Answers whether the click was a pick, not "list the next batch".
   */
  more(event: MouseEvent, hidden: readonly string[], key: string, open: string | undefined) {
    if (!event.metaKey && !event.ctrlKey && !event.shiftKey) return false;
    event.preventDefault();
    const from = open && open !== "pai" ? open : null;
    const all = this.allPicked(hidden);
    if (event.shiftKey) {
      this.range(hidden[0]!, this.anchor ?? from);
      this.pick(hidden);
    } else if (all) this.unpick(hidden);
    else {
      if (!this.selected.size && from && !hidden.includes(from)) this.pick([from]);
      this.pick(hidden);
    }
    this.anchor ??= hidden[0]!;
    this.last = this.allPicked(hidden) ? key : null;
    return true;
  }

  /** Right click on "N more": moves what is picked, or else the rows it hides. */
  moreMenu(event: MouseEvent, hidden: readonly string[]) {
    event.preventDefault();
    const ids = this.selected.size ? [...this.selected] : hidden;
    menus.openContext(event.clientX, event.clientY, [{ label: `Move ${ids.length} into…`, icon: "arrows", run: () => mover.start(ids) }]);
  }

  clear() {
    if (!this.selected.size && !this.anchor) return;
    this.selected = new Set();
    this.anchor = null;
    this.last = null;
  }
}

export const selection = new Selection();
