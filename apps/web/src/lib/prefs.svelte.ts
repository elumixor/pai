import { recall, remember } from "./storage";

const KEY = "pai.prefs";

/** Small per-browser preferences beyond the theme: which usage windows the rings leave out. */
class Prefs {
  hiddenRings = $state<string[]>(recall<{ hiddenRings: string[] }>(KEY, { hiddenRings: [] }).hiddenRings);

  toggleRing(name: string, shown: boolean) {
    this.hiddenRings = shown ? this.hiddenRings.filter((n) => n !== name) : [...new Set([...this.hiddenRings, name])];
    remember(KEY, JSON.stringify({ hiddenRings: this.hiddenRings }));
  }
}

export const prefs = new Prefs();
