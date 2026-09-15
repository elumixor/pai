/** Light, dark, or whatever the system says; kept per browser, applied as `data-theme` on the root. */
export type Theme = "system" | "light" | "dark";

const KEY = "pai.theme";
const media = matchMedia("(prefers-color-scheme: dark)");

export const theme = (): Theme => (localStorage.getItem(KEY) as Theme | null) ?? "system";

export const isDark = () => {
  const chosen = theme();
  return chosen === "system" ? media.matches : chosen === "dark";
};

export function setTheme(next: Theme) {
  localStorage.setItem(KEY, next);
  apply();
}

function apply() {
  const chosen = theme();
  if (chosen === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", chosen);
  window.dispatchEvent(new Event("pai:theme"));
}

/** Runs once at import, so the first paint is already the right colour. */
apply();
media.addEventListener("change", () => theme() === "system" && apply());

/** Calls back whenever the effective look changes, and returns a way to stop. */
export function onTheme(listener: () => void) {
  window.addEventListener("pai:theme", listener);
  return () => window.removeEventListener("pai:theme", listener);
}
