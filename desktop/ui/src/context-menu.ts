import { el } from "./dom.ts";
import { icon, type IconName } from "./icons.ts";

export interface ContextAction {
  readonly label: string;
  readonly icon: IconName;
  readonly run: () => void;
}

/**
 * The menu a right click opens at the pointer: rows with an icon, grown out of the corner nearest the
 * pointer. Arrows move, Enter picks; a pick, a click outside, Escape, a scroll or the window losing focus close it.
 */
export function contextMenu(x: number, y: number, actions: readonly ContextAction[]) {
  document.querySelector(".ctx-menu")?.remove();
  if (!actions.length) return;
  const rows = actions.map((action) => el("button.ctx-row", { type: "button", onclick: () => (close(), action.run()) }, icon(action.icon, 14), el("span", {}, action.label)));
  const box = el("div.ctx-menu", { role: "menu" }, ...rows);
  document.body.append(box);
  const left = x + box.offsetWidth > window.innerWidth - 8 ? x - box.offsetWidth : x;
  const top = y + box.offsetHeight > window.innerHeight - 8 ? y - box.offsetHeight : y;
  box.style.left = `${Math.max(8, left)}px`;
  box.style.top = `${Math.max(8, top)}px`;
  box.style.transformOrigin = `${left < x ? "right" : "left"} ${top < y ? "bottom" : "top"}`;
  requestAnimationFrame(() => box.classList.add("open"));
  let focused = -1;
  const focus = (i: number) => {
    focused = (i + rows.length) % rows.length;
    rows[focused]!.focus();
  };
  const close = () => {
    box.classList.remove("open");
    box.classList.add("closing");
    setTimeout(() => box.remove(), 120);
    document.removeEventListener("mousedown", outside, true);
    document.removeEventListener("keydown", keys, true);
    document.removeEventListener("wheel", close, true);
    window.removeEventListener("blur", close);
  };
  const outside = (event: Event) => !box.contains(event.target as Node) && close();
  const keys = (event: KeyboardEvent) => {
    if (event.key === "Escape") close();
    else if (event.key === "ArrowDown") focus(focused + 1);
    else if (event.key === "ArrowUp") focus(focused - 1);
    else return;
    event.preventDefault();
  };
  setTimeout(() => {
    document.addEventListener("mousedown", outside, true);
    document.addEventListener("keydown", keys, true);
    document.addEventListener("wheel", close, true);
    window.addEventListener("blur", close);
  });
}
