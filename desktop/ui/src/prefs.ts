import { remember } from "./storage.ts";
/** Small per-browser preferences beyond the theme: which usage rings the status bar shows. */
const KEY = "pai.prefs";

export interface Prefs {
  /** Window names to show as rings; empty means all of them. */
  rings: string[];
  /** Windows the status bar hides. */
  hiddenRings: string[];
}

const read = (): Prefs => {
  try {
    return { rings: [], hiddenRings: [], ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Prefs>) };
  } catch {
    return { rings: [], hiddenRings: [] };
  }
};

export const prefs = read;

export function setPrefs(changes: Partial<Prefs>) {
  remember(KEY, JSON.stringify({ ...read(), ...changes }));
  window.dispatchEvent(new Event("pai:prefs"));
}
