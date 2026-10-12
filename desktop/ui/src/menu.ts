import { el } from "./dom.ts";

/** A small menu under a button: rows to pick from, the current one bold; closes on a pick, a click outside, or Escape. */
export interface MenuRow {
  readonly label: string;
  readonly hint?: string;
  readonly on?: boolean;
  readonly pick: () => void;
}

export function menu(anchor: HTMLElement, rows: readonly MenuRow[]) {
  document.querySelector(".menu")?.remove();
  const box = el(
    "div.menu",
    {},
    ...rows.map((row) => el("button.menu-row", { class: `menu-row${row.on ? " on" : ""}`, onclick: () => (close(), row.pick()) }, el("span", {}, row.label), row.hint ? el("span.dim", {}, row.hint) : undefined)),
  );
  const close = () => {
    box.remove();
    document.removeEventListener("mousedown", outside, true);
    document.removeEventListener("keydown", escape, true);
  };
  const outside = (event: Event) => !box.contains(event.target as Node) && event.target !== anchor && close();
  const escape = (event: KeyboardEvent) => event.key === "Escape" && close();
  document.body.append(box);
  const at = anchor.getBoundingClientRect();
  box.style.left = `${Math.min(at.left, window.innerWidth - box.offsetWidth - 8)}px`;
  box.style.top = `${at.top - box.offsetHeight - 6 < 0 ? at.bottom + 6 : at.top - box.offsetHeight - 6}px`;
  setTimeout(() => {
    document.addEventListener("mousedown", outside, true);
    document.addEventListener("keydown", escape, true);
  });
  return close;
}
