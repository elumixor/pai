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

const read = (): Choice => {
  try {
    return { mode: "system", light: "pai-light", dark: "pai-dark", ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Choice>) };
  } catch {
    return { mode: "system", light: "pai-light", dark: "pai-dark" };
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
  localStorage.setItem(KEY, JSON.stringify({ ...read(), ...changes }));
  apply();
}

const VARS: Record<keyof Theme["ui"], string> = {
  bg: "--bg", panel: "--panel", panel2: "--panel-2", line: "--line", line2: "--line-2", text: "--text", dim: "--dim", accent: "--accent", accentInk: "--accent-ink",
  busy: "--busy", idle: "--idle", warn: "--warn", hot: "--hot", codeBg: "--code-bg", selection: "--selection",
};

function apply() {
  const theme = current();
  const root = document.documentElement;
  for (const [key, name] of Object.entries(VARS)) root.style.setProperty(name, theme.ui[key as keyof Theme["ui"]]);
  root.style.colorScheme = theme.kind;
  root.dataset.theme = theme.kind;
  window.dispatchEvent(new Event("pai:theme"));
}

apply();
media.addEventListener("change", () => read().mode === "system" && apply());

/** Calls back whenever the look changes, and returns a way to stop. */
export function onTheme(listener: () => void) {
  window.addEventListener("pai:theme", listener);
  return () => window.removeEventListener("pai:theme", listener);
}
