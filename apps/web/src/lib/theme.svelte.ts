import { applyTheme, DEFAULT_THEME, onSystemTheme, type Palette, type ThemeChoice } from "@desk/core";
import { recall, remember } from "./storage";

const KEY = "pai.theme";

/**
 * Which palette is on: a light one and a dark one are chosen, and the mode says whether the system decides between
 * them. Applied as attributes on the root, which `@desk/core/tokens.css` reads, so the whole page follows.
 */
class Theme {
  choice = $state<ThemeChoice>(recall(KEY, DEFAULT_THEME));
  palette = $state<Palette>(applyTheme(this.choice));

  constructor() {
    onSystemTheme(() => this.choice.mode === "system" && this.#apply());
  }

  choose(changes: Partial<ThemeChoice>) {
    this.choice = { ...this.choice, ...changes };
    remember(KEY, JSON.stringify(this.choice));
    this.#apply();
  }

  #apply() {
    this.palette = applyTheme(this.choice);
  }
}

export const theme = new Theme();
