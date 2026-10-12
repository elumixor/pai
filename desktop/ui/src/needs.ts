import { el } from "./dom.ts";
import { icon } from "./icons.ts";
import type { Need } from "./types.ts";

/**
 * The hand above the box: how many things wait on the user. A press scrolls the chat to the
 * next one of them; pressing on cycles through them, oldest first.
 */
export function needsButton(options: { readonly reveal: (need: Need) => void }) {
  const count = el("span");
  let needs: readonly Need[] = [];
  let cursor = 0;
  const next = () => {
    if (!needs.length) return;
    const need = needs[cursor % needs.length]!;
    cursor = (cursor + 1) % needs.length;
    options.reveal(need);
  };
  const button = el("button.needs-btn", { title: "what waits on you — press to go to the next", hidden: true, onclick: next }, icon("hand", 15), count);
  window.addEventListener("pai:pile", next);

  return {
    node: el("div.needs", {}, button),
    draw(list: readonly Need[]) {
      // Oldest first, so the cycle walks the chat downwards.
      needs = [...list].sort((a, b) => a.createdAt - b.createdAt);
      if (cursor >= needs.length) cursor = 0;
      window.dispatchEvent(new CustomEvent("pai:needs", { detail: needs.length }));
      count.textContent = String(needs.length);
      button.hidden = !needs.length;
    },
  };
}
