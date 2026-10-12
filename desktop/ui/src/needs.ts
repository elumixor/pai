import { answerNeed } from "./api.ts";
import { clear, el } from "./dom.ts";
import { icon } from "./icons.ts";
import { markdown } from "./markdown.ts";
import type { Need } from "./types.ts";

/**
 * The hand above the box: how many things wait on the user. A press scrolls the chat to the
 * next one of them; pressing on cycles through them, oldest first. A need with no row to scroll
 * to (a task nobody wrote a message about, an ask older than the chat loads) opens as a card
 * above the hand, answerable there — a press always lands on the decision itself.
 */
export function needsButton(options: { readonly reveal: (need: Need) => void; readonly answered: () => void; readonly openBoard: (need: Need) => void }) {
  const count = el("span");
  let needs: readonly Need[] = [];
  let cursor = 0;
  const next = () => {
    if (!needs.length) return;
    const need = needs[cursor % needs.length]!;
    cursor = (cursor + 1) % needs.length;
    hide();
    options.reveal(need);
  };
  const button = el("button.needs-btn", { title: "what waits on you — press to go to the next", hidden: true, onclick: next }, icon("hand", 15), count);
  const card = el("div.need-card.row.question", { hidden: true });
  const node = el("div.needs", {}, card, button);
  let shown: Need | undefined;

  function hide() {
    shown = undefined;
    card.hidden = true;
    button.classList.remove("open");
  }

  function show(need: Need) {
    shown = need;
    const note = el("span.need-note");
    const reply = async (text: string) => {
      if (!text.trim()) return;
      const result = await answerNeed(need.id, text);
      if (result.error) return void (note.textContent = result.error);
      hide();
      options.answered();
    };
    const input = el("input.need-input", { type: "text", placeholder: "answer in words…", onkeydown: (e: Event) => void ((e as KeyboardEvent).key === "Enter" && reply(input.value)) }) as HTMLInputElement;
    const choices = need.options.map((option) => el("button.opt", { onclick: () => void reply(option) }, option));
    clear(
      card,
      el(
        "div.q-meta",
        {},
        icon("hand", 10),
        el("b", {}, "Action needed"),
        el("span", {}, need.from),
        el("span.grow"),
        el("button.need-close", { title: "close", onclick: hide }, icon("x", 12)),
      ),
      el("div.q-body", {}, markdown(need.question)),
      el(
        "div.q-options",
        {},
        ...choices,
        need.link ? el("a.opt", { href: need.link, target: "_blank", rel: "noreferrer" }, icon("external", 11), " Open") : undefined,
        need.taskId !== undefined ? el("button.opt.faint", { onclick: () => (hide(), options.openBoard(need)) }, "On the board") : undefined,
      ),
      need.freeText || !need.options.length ? input : undefined,
      note,
    );
    card.hidden = false;
    button.classList.add("open");
    if (need.freeText || !need.options.length) input.focus();
  }

  window.addEventListener("pai:pile", next);
  window.addEventListener("keydown", (e) => e.key === "Escape" && shown && hide());

  return {
    node,
    /** The need had no row in the chat: it opens here instead. */
    show,
    draw(list: readonly Need[]) {
      // Oldest first, so the cycle walks the chat downwards.
      needs = [...list].sort((a, b) => a.createdAt - b.createdAt);
      if (cursor >= needs.length) cursor = 0;
      if (shown && !needs.some((n) => n.id === shown!.id)) hide();
      window.dispatchEvent(new CustomEvent("pai:needs", { detail: needs.length }));
      count.textContent = String(needs.length);
      button.hidden = !needs.length;
    },
  };
}
