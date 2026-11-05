import { applyTheme, DEFAULT_THEME, onSystemTheme, type Palette, PALETTES, paletteById, type ThemeChoice, type ThemeKind, themeKind } from "@desk/core";
import { api } from "./api";
import { forget, recall, remember } from "./storage";
import { compileTheme, type CustomTheme, swatchOf } from "./theme/custom";

const KEY = "pai.theme";
const THEMES_KEY = "pai.themes";
const BOOT_KEY = "pai.theme.boot";
const STYLE_ID = "pai-theme";
const SAVE_DELAY_MS = 500;

function writeStyle(css: string) {
  const existing = document.getElementById(STYLE_ID);
  if (existing) return void (existing.textContent = css);
  if (!css) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = css;
  document.head.append(style);
}

/**
 * Which palette is on: a light one and a dark one are chosen, and the mode says whether the system decides between
 * them. Applied as attributes on the root, which `@desk/core/tokens.css` reads, so the whole page follows. A theme of
 * one's own shows as its base palette plus a stylesheet of its changes. Themes are held by the daemon and kept here
 * too, so `app.html` can show the right one before anything has loaded. The choice lives there as well, so every
 * browser, local or production, wears the same look; this browser's copy is only for the first paint.
 */
class Theme {
  choice = $state<ThemeChoice>(recall(KEY, DEFAULT_THEME));
  custom = $state<readonly CustomTheme[]>(recall<CustomTheme[]>(THEMES_KEY, []));
  saveError = $state("");
  palette = $state<Palette>(this.#show());
  readonly palettes = $derived<readonly Palette[]>([...PALETTES, ...this.custom.flatMap((custom) => this.#asPalette(custom))]);

  readonly #pending = new Map<string, ReturnType<typeof setTimeout>>();
  #loaded = false;

  constructor() {
    onSystemTheme(() => this.choice.mode === "system" && this.#apply());
  }

  choose(changes: Partial<ThemeChoice>) {
    this.choice = { ...this.choice, ...changes };
    remember(KEY, JSON.stringify(this.choice));
    this.#apply();
    void api.savePrefs({ theme: this.choice }).catch((error: Error) => this.#failed(error));
  }

  /** Puts a palette on, in its own light or dark. */
  pick({ id, kind }: Pick<Palette, "id" | "kind">) {
    this.choose({ [kind]: id, mode: kind });
  }

  nameOf(id: string) {
    return this.palettes.find((palette) => palette.id === id)?.name ?? id;
  }

  find(id: string) {
    return this.custom.find((custom) => custom.id === id);
  }

  /** The daemon's themes, which win over what this browser kept. Once: only signed in does the daemon answer. */
  async load() {
    if (this.#loaded) return;
    this.#loaded = true;
    try {
      const [custom, prefs] = await Promise.all([api.themes(), api.prefs()]);
      this.custom = custom as readonly CustomTheme[];
      this.#keep();
      // The first browser to get here has its choice taken up; after that the daemon's is the one.
      if (prefs.theme) {
        this.choice = { ...DEFAULT_THEME, ...(prefs.theme as Partial<ThemeChoice>) };
        remember(KEY, JSON.stringify(this.choice));
      } else await api.savePrefs({ theme: this.choice });
      this.#apply();
    } catch (error) {
      console.warn("[theme] the daemon's themes are unavailable, using this browser's", error);
    }
  }

  /** A copy of any palette or theme, and it is not put on: the caller decides. */
  create(fromId: string): CustomTheme {
    const source = this.find(fromId);
    const created: CustomTheme = {
      id: `custom-${crypto.randomUUID()}`,
      name: `${this.nameOf(fromId)} copy`,
      base: source?.base ?? fromId,
      tokens: { ...source?.tokens },
      elements: { ...source?.elements },
    };
    this.custom = [...this.custom, created];
    this.#changed(created);
    return created;
  }

  update(next: CustomTheme) {
    this.custom = this.custom.map((custom) => (custom.id === next.id ? next : custom));
    this.#changed(next);
  }

  remove(id: string) {
    const theme = this.find(id);
    if (!theme) return;
    clearTimeout(this.#pending.get(id));
    this.#pending.delete(id);
    this.custom = this.custom.filter((custom) => custom.id !== id);
    const inUse = (["light", "dark"] as const).filter((kind) => this.choice[kind] === id);
    this.#keep();
    if (inUse.length) this.choose(Object.fromEntries(inUse.map((kind) => [kind, theme.base])));
    else this.#apply();
    void api.dropTheme(id).catch((error: Error) => this.#failed(error));
  }

  /** Writes now what is waiting: leaving the editor must not lose its last change. */
  flush() {
    for (const id of [...this.#pending.keys()]) this.#save(id);
  }

  #asPalette(custom: CustomTheme): Palette[] {
    const base = paletteById(custom.base);
    return base ? [{ id: custom.id, name: custom.name, kind: base.kind, swatch: swatchOf(custom, base.swatch) as Palette["swatch"] }] : [];
  }

  #changed(theme: CustomTheme) {
    this.#keep();
    this.#apply();
    clearTimeout(this.#pending.get(theme.id));
    this.#pending.set(
      theme.id,
      setTimeout(() => this.#save(theme.id), SAVE_DELAY_MS),
    );
  }

  #save(id: string) {
    clearTimeout(this.#pending.get(id));
    this.#pending.delete(id);
    const theme = this.find(id);
    if (!theme) return;
    api
      .saveTheme(theme)
      .then(() => (this.saveError = ""))
      .catch((error: Error) => this.#failed(error));
  }

  #failed(error: Error) {
    this.saveError = `Could not save to pai: ${error.message}`;
    console.warn("[theme] save failed", error);
  }

  #keep() {
    remember(THEMES_KEY, JSON.stringify(this.custom));
  }

  #apply() {
    this.palette = this.#show();
  }

  #show(): Palette {
    const resolve = (id: string) => this.custom.find((custom) => custom.id === id)?.base ?? id;
    const shown = applyTheme({ ...this.choice, light: resolve(this.choice.light), dark: resolve(this.choice.dark) });
    const active = this.custom.find((custom) => custom.id === this.choice[themeKind(this.choice)]);
    writeStyle(active ? compileTheme(active) : "");
    this.#writeBoot();
    return active ? (this.#asPalette(active)[0] ?? shown) : shown;
  }

  /** What the page needs before its first paint, per mode, for the modes showing a theme of one's own. */
  #writeBoot() {
    const entries = (["light", "dark"] as const satisfies readonly ThemeKind[]).flatMap((kind) => {
      const custom = this.custom.find((candidate) => candidate.id === this.choice[kind]);
      return custom ? [[kind, { palette: custom.base, css: compileTheme(custom) }]] : [];
    });
    if (entries.length) remember(BOOT_KEY, JSON.stringify(Object.fromEntries(entries)));
    else forget(BOOT_KEY);
  }
}

export const theme = new Theme();
