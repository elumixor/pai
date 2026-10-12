import { ago, clear, el } from "./dom.ts";
import { icon } from "./icons.ts";
import { kindIcon } from "./kinds.ts";
import { markdown } from "./markdown.ts";
import type { Need } from "./types.ts";

/**
 * The hand above the box: how many things wait on the user. A click unfolds them as cards,
 * newest first; a card finds its row in the chat.
 */
const firstLine = (text: string) => text.replace(/^\[[^\]]+\]\s*/, "").split("\n").find((l) => l.trim()) ?? "";

export function needsButton(options: { readonly nameOf: (need: Need) => string; readonly reveal: (need: Need) => void }) {
  const count = el("span");
  const list = el("div.needs-list", { hidden: true });
  const button = el("button.needs-btn", { title: "what waits on you", hidden: true, onclick: () => setOpen(list.hidden) }, icon("hand", 15), count);
  const setOpen = (open: boolean) => {
    list.hidden = !open;
    button.classList.toggle("open", open);
  };
  document.addEventListener("click", (event) => {
    if (!list.hidden && !list.contains(event.target as Node) && !button.contains(event.target as Node)) setOpen(false);
  });
  window.addEventListener("pai:pile", () => setOpen(list.hidden));

  const card = (n: Need) =>
    el(
      "button.need-card",
      { class: `need-card ${n.kind}${n.priority !== "normal" ? ` prio-${n.priority}` : ""}`, onclick: () => (setOpen(false), options.reveal(n)) },
      el("span.need-meta", {}, kindIcon(n.kind === "task" ? "notice" : n.kind === "ask" ? "ask" : "question", 10), el("b", {}, options.nameOf(n)), n.taskId ? el("span.tag", {}, `#${n.taskId}`) : undefined, el("span.grow"), el("time", {}, ago(n.createdAt))),
      el("span.need-text", {}, markdown(firstLine(n.question))),
      n.options.length ? el("span.need-options.ellipsis", {}, n.options.join(" · ")) : undefined,
    );

  return {
    node: el("div.needs", {}, list, button),
    draw(needs: readonly Need[]) {
      window.dispatchEvent(new CustomEvent("pai:needs", { detail: needs.length }));
      count.textContent = String(needs.length);
      button.hidden = !needs.length;
      if (!needs.length) setOpen(false);
      clear(list, ...needs.map(card));
    },
  };
}
