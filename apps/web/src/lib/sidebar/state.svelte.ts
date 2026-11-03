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
