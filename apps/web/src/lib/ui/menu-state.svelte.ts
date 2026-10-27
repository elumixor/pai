import type { IconName } from "../icons";

/** A row of the menu a right click opens. */
export interface ContextAction {
  readonly label: string;
  readonly icon: IconName;
  readonly run: () => void;
}

/** A row of the small menu under a button: the current one bold. */
export interface MenuRow {
  readonly label: string;
  readonly hint?: string;
  readonly on?: boolean;
  readonly pick: () => void;
}

/**
 * The two small menus the page has, one of each open at a time: the context menu at the pointer, and the menu a
 * button opens above (or below) itself. `Menus.svelte` draws them.
 */
class Menus {
  context = $state<{ x: number; y: number; actions: readonly ContextAction[] } | null>(null);
  dropdown = $state<{ anchor: HTMLElement; rows: readonly MenuRow[] } | null>(null);

  openContext(x: number, y: number, actions: readonly ContextAction[]) {
    this.context = actions.length ? { x, y, actions } : null;
  }

  openDropdown(anchor: HTMLElement, rows: readonly MenuRow[]) {
    this.dropdown = { anchor, rows };
  }

  close() {
    this.context = null;
    this.dropdown = null;
  }
}

export const menus = new Menus();
