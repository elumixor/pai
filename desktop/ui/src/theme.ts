import { remember } from "./storage.ts";
import { THEMES, themeById, type Theme } from "./themes.ts";

/**
 * Which theme is on: a light one and a dark one are chosen, and the mode says whether the
 * system decides between them. Applied as CSS variables on the root, so every part of the
 * page — the chrome, the editor, the terminal — reads the same colours.
 */
export type Mode = "system" | "light" | "dark";

const KEY = "pai.theme";
const media = matchMedia("(prefers-color-scheme: dark)");

interface Choice {
  mode: Mode;
  light: string;
  dark: string;
}

// Nord Light became the light theme once, whatever was picked before it existed; a pick after that stays.
try {
  const stored = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Choice>;
  if (stored.light && !localStorage.getItem(`${KEY}.nord-light`)) remember(KEY, JSON.stringify({ ...stored, light: "nord-light" }));
  remember(`${KEY}.nord-light`, "1");
} catch {}

const read = (): Choice => {
  try {
    return { mode: "system", light: "nord-light", dark: "pai-dark", ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Choice>) };
  } catch {
    return { mode: "system", light: "nord-light", dark: "pai-dark" };
  }
};

export const choice = read;

export const isDark = () => {
  const { mode } = read();
  return mode === "system" ? media.matches : mode === "dark";
};

export const current = (): Theme => {
  const chosen = read();
  return themeById(isDark() ? chosen.dark : chosen.light) ?? THEMES[0]!;
};

export function choose(changes: Partial<Choice>) {
  remember(KEY, JSON.stringify({ ...read(), ...changes }));
  apply();
}

const VARS: Record<keyof Theme["ui"], string> = {
  bg: "--bg", panel: "--panel", panel2: "--panel-2", line: "--line", line2: "--line-2", text: "--text", dim: "--dim", accent: "--accent", accentInk: "--accent-ink",
  busy: "--busy", idle: "--idle", warn: "--warn", hot: "--hot", codeBg: "--code-bg", selection: "--selection",
};

let applied: string[] = [];

function apply() {
  const theme = current();
  const root = document.documentElement;
  for (const [key, name] of Object.entries(VARS)) root.style.setProperty(name, theme.ui[key as keyof Theme["ui"]]);
  // The main view's tokens a theme sets itself; the ones it leaves fall back to the stylesheet's.
  for (const name of applied) root.style.removeProperty(name);
  applied = Object.keys(theme.home ?? {});
  for (const [name, value] of Object.entries(theme.home ?? {})) root.style.setProperty(name, value);
  root.style.colorScheme = theme.kind;
  root.dataset.theme = theme.kind;
  // What the page paints before this module runs (see the inline script in index.html).
  try {
    remember(`${KEY}.boot`, JSON.stringify({ kind: theme.kind, bg: theme.home?.["--canvas"] ?? theme.ui.bg }));
  } catch {}
  window.dispatchEvent(new Event("pai:theme"));
}

apply();
media.addEventListener("change", () => read().mode === "system" && apply());

/** Calls back whenever the look changes, and returns a way to stop. */
export function onTheme(listener: () => void) {
  window.addEventListener("pai:theme", listener);
  return () => window.removeEventListener("pai:theme", listener);
}
