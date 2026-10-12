import { agent as fetchAgent } from "./api.ts";
import { clear, el } from "./dom.ts";
import { icon } from "./icons.ts";
import type { Need, TaskItem, TaskStatus } from "./types.ts";

/**
 * The card a long hover over a project opens: how many tasks wait, run and are done; the
 * first few of them (the running ones first); and the decisions that wait on the user in it.
 */
const HOVER_MS = 600;
const SHOWN_TASKS = 4;
const SHOWN_NEEDS = 1;
const TODO: readonly TaskStatus[] = ["inbox", "scheduled", "waiting_user"];
const ACTIVE: readonly TaskStatus[] = ["active", "waiting_other"];
const DONE: readonly TaskStatus[] = ["done", "dropped"];
const firstLine = (text: string) => text.replace(/^\[[^\]]+\]\s*/, "").split("\n").find((l) => l.trim()) ?? "";

export function projectPeek(options: { readonly needsOf: (slug: string) => readonly Need[] }) {
  const card = el("div.peek", { hidden: true });
  document.body.append(card);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let shownFor: string | undefined;

  const count = (n: number, label: string) => el("span.peek-count", {}, el("b", {}, String(n)), el("span", {}, ` ${label}`));
  const more = (n: number) => (n > 0 ? el("span.peek-more", {}, `${n} more`) : undefined);
  const taskRow = (t: TaskItem) => el("span.peek-task", { class: `peek-task${ACTIVE.includes(t.status) ? " active" : ""}` }, ACTIVE.includes(t.status) ? el("span.spinner") : icon("circleCheck", 15), el("span.ellipsis", {}, t.title));

  function draw(tasks: readonly TaskItem[], needs: readonly Need[]) {
    const todo = tasks.filter((t) => TODO.includes(t.status));
    const active = tasks.filter((t) => ACTIVE.includes(t.status));
    const done = tasks.filter((t) => DONE.includes(t.status));
    const open = [...active, ...todo];
    clear(
      card,
      el("div.peek-head", {}, count(todo.length, "todo"), count(active.length, "active"), count(done.length, "done")),
      open.length ? el("div.peek-tasks", {}, ...open.slice(0, SHOWN_TASKS).map(taskRow), more(open.length - SHOWN_TASKS)) : undefined,
      needs.length ? el("div.peek-needs", {}, ...needs.slice(0, SHOWN_NEEDS).map((n) => el("span.peek-need.ellipsis", {}, firstLine(n.question))), more(needs.length - SHOWN_NEEDS)) : undefined,
    );
  }

  function place(anchor: HTMLElement) {
    const at = anchor.getBoundingClientRect();
    card.hidden = false;
    const left = Math.min(at.right + 14, window.innerWidth - card.offsetWidth - 8);
    const top = Math.min(at.top - 8, window.innerHeight - card.offsetHeight - 8);
    card.style.left = `${left}px`;
    card.style.top = `${Math.max(8, top)}px`;
  }

  const hide = () => {
    clearTimeout(timer);
    card.hidden = true;
    shownFor = undefined;
  };

  return {
    /** Arms a row: the card opens after a long hover and closes when the pointer leaves. */
    attach(row: HTMLElement, slug: string) {
      row.addEventListener("mouseenter", () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          shownFor = slug;
          const full = await fetchAgent(slug).catch(() => undefined);
          if (shownFor !== slug || !row.matches(":hover")) return;
          draw(full?.tasks ?? [], options.needsOf(slug));
          place(row);
        }, HOVER_MS);
      });
      row.addEventListener("mouseleave", hide);
      row.addEventListener("mousedown", hide);
    },
    hide,
  };
}
