import { agent as fetchAgent, answerNeed } from "./api.ts";
import { ago, clear, el } from "./dom.ts";
import { hoverCard } from "./hover.ts";
import { icon, type IconName } from "./icons.ts";
import { markdown } from "./markdown.ts";
import type { Need, TaskItem, TaskStatus } from "./types.ts";

/**
 * The card a long hover over a project opens: how many tasks wait, run, wait on the user and are
 * done; the open tasks (a spinner only on one whose agent is at work right now); and under them
 * the decisions that wait on the user, a row per task. Hovering a decision opens a second card
 * beside the first with what is asked, answerable in place. Both are reachable with the pointer
 * (`hover.ts`), both lists scroll.
 */
const HOVER_MS = 600;
const FLY_MS = 120;
const TODO: readonly TaskStatus[] = ["inbox", "scheduled"];
const ACTIVE: readonly TaskStatus[] = ["active", "waiting_other"];
const DONE: readonly TaskStatus[] = ["done", "dropped"];
const firstLine = (text: string) => text.replace(/^\[[^\]]+\]\s*/, "").split("\n").find((l) => l.trim()) ?? "";
const rest = (text: string) => text.replace(/^\[[^\]]+\]\s*/, "").replace(/^\s*[^\n]*\n?/, "").trim();

/** One row under the tasks: a task with the decisions it waits on, or a decision of no task. */
interface Decision {
  readonly key: string;
  readonly label: string;
  readonly needs: readonly Need[];
}

export function projectPeek(options: {
  readonly needsOf: (slug: string) => readonly Need[];
  /** The agent is in a turn now. */
  readonly working: (slug: string) => boolean;
  readonly openTask: (id: number) => void;
  readonly reveal: (need: Need) => void;
  readonly answered: () => void;
}) {
  const card = el("div.peek", { hidden: true });
  const fly = el("div.peek.peek-fly", { hidden: true });
  document.body.append(card, fly);
  let slug: string | undefined;
  let tasks: readonly TaskItem[] = [];
  let decisions: readonly Decision[] = [];

  const flyout = hoverCard(fly, {
    openMs: FLY_MS,
    sticky: () => [...fly.querySelectorAll<HTMLInputElement>(".peek-input")].some((input) => input.value.trim() !== ""),
    onHide: () => card.querySelectorAll(".peek-need.on").forEach((row) => row.classList.remove("on")),
    show: (row, key) => {
      const decision = decisions.find((d) => d.key === key);
      if (!decision) return false;
      drawDecision(decision);
      placeBeside(row);
      for (const other of card.querySelectorAll(".peek-need.on")) other.classList.remove("on");
      row.classList.add("on");
      return true;
    },
  });
  const peek = hoverCard(card, {
    openMs: HOVER_MS,
    nested: () => [flyout],
    onHide: () => flyout.dismiss(),
    show: async (row, key) => {
      if (key !== slug) flyout.dismiss();
      const full = await fetchAgent(key).catch(() => undefined);
      [slug, tasks] = [key, full?.tasks ?? []];
      draw();
      placeRight(row);
      return true;
    },
  });

  const count = (n: number, label: string, cls = "") => el("span.peek-count", { class: `peek-count${cls}` }, el("b", {}, String(n)), el("span", {}, ` ${label}`));

  function taskIcon(t: TaskItem): Element {
    if (t.status === "active" && options.working(t.owner)) return el("span.spinner");
    const name: IconName = t.status === "waiting_other" ? "hourglass" : t.status === "active" ? "play" : "circle";
    return icon(name, 14);
  }

  function taskRow(t: TaskItem) {
    const running = t.status === "active" && options.working(t.owner);
    return el(
      "button.peek-task",
      { class: `peek-task${running ? " running" : ""}${ACTIVE.includes(t.status) ? " active" : ""}`, title: t.nextAction || t.title, onclick: () => (peek.dismiss(), options.openTask(t.id)) },
      taskIcon(t),
      el("span.ellipsis", {}, t.title),
    );
  }

  function decisionRow(d: Decision) {
    const row = el(
      "button.peek-need",
      { class: `peek-need${flyout.shown() === d.key ? " on" : ""}`, onclick: () => (peek.dismiss(), options.reveal(d.needs[0]!)) },
      icon("hand", 13),
      el("span.ellipsis", {}, d.label),
      d.needs.length > 1 ? el("span.peek-need-count", {}, String(d.needs.length)) : undefined,
      icon("chevron", 8),
    );
    flyout.arm(row, d.key);
    return row;
  }

  function draw() {
    if (!slug) return;
    const needs = options.needsOf(slug);
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const grouped = new Map<string, Need[]>();
    for (const n of needs) {
      const key = n.taskId !== undefined ? `task:${n.taskId}` : n.id;
      grouped.set(key, [...(grouped.get(key) ?? []), n]);
    }
    decisions = [...grouped].map(([key, list]) => {
      const task = list[0]!.taskId !== undefined ? byId.get(list[0]!.taskId) : undefined;
      return { key, label: task?.title ?? firstLine(list[0]!.question), needs: list.sort((a, b) => a.createdAt - b.createdAt) };
    });
    const deciding = new Set(needs.map((n) => n.taskId).filter((id) => id !== undefined));
    const waits = (t: TaskItem) => deciding.has(t.id) || t.status === "waiting_user";
    const todo = tasks.filter((t) => TODO.includes(t.status) && !waits(t));
    const active = tasks.filter((t) => ACTIVE.includes(t.status) && !waits(t));
    const done = tasks.filter((t) => DONE.includes(t.status));
    const rank = (t: TaskItem) => (t.status === "active" && options.working(t.owner) ? 0 : t.status === "active" ? 1 : t.status === "waiting_other" ? 2 : 3);
    const open = [...active, ...todo].sort((a, b) => rank(a) - rank(b));
    clear(
      card,
      el(
        "div.peek-head",
        {},
        count(todo.length, "todo"),
        count(active.length, "active"),
        needs.length ? count(needs.length, needs.length === 1 ? "decision" : "decisions", " hand") : undefined,
        count(done.length, "done"),
      ),
      open.length ? el("div.peek-tasks", {}, ...open.map(taskRow)) : undefined,
      decisions.length ? el("div.peek-needs", {}, ...decisions.map(decisionRow)) : undefined,
    );
    if (flyout.shown() && !decisions.some((d) => d.key === flyout.shown())) flyout.dismiss();
  }

  function drawDecision(d: Decision) {
    clear(fly, ...d.needs.map(needBlock));
  }

  function needBlock(n: Need) {
    const note = el("span.peek-q-note");
    const settle = (text: string) => clear(block, el("div.q-answer", {}, icon("check", 10), el("span", {}, `${firstLine(n.question)} — ${text}`)));
    const reply = async (text: string) => {
      if (!text.trim()) return;
      note.textContent = "";
      const result = await answerNeed(n.id, text.trim());
      if (result.error) note.textContent = result.error;
      else (settle(text.trim()), options.answered());
    };
    const input = n.freeText
      ? el("input.peek-input", {
          placeholder: n.options.length ? "Or answer in words…" : "Answer…",
          onkeydown: (event: Event) => {
            const key = event as KeyboardEvent;
            if (key.key === "Enter" && !key.isComposing) void reply((key.target as HTMLInputElement).value);
          },
        })
      : undefined;
    const block = el(
      "div.peek-q",
      {},
      el("div.peek-q-meta", {}, icon("hand", 11), el("b", {}, n.from), el("span", {}, `${ago(n.createdAt)} ago`), n.priority !== "normal" ? el("span.tag", { class: `tag prio-${n.priority}` }, n.priority) : undefined),
      el("div.peek-q-title", {}, firstLine(n.question)),
      rest(n.question) ? el("div.peek-q-body.q-body", {}, markdown(rest(n.question))) : undefined,
      n.options.length ? el("div.q-options", {}, ...n.options.map((option) => el("button.opt", { onclick: () => void reply(option) }, option))) : undefined,
      input,
      el("div.peek-q-foot", {}, note, el("button.peek-q-open", { onclick: () => (peek.dismiss(), options.reveal(n)) }, "Open in chat", icon("chevron", 8))),
    );
    return block;
  }

  function placeRight(anchor: HTMLElement) {
    card.hidden = false;
    const at = anchor.getBoundingClientRect();
    const left = Math.min(at.right + 14, window.innerWidth - card.offsetWidth - 8);
    const top = Math.min(at.top - 8, window.innerHeight - card.offsetHeight - 8);
    card.style.left = `${left}px`;
    card.style.top = `${Math.max(8, top)}px`;
  }

  /** Beside the card, level with the row; on the left when the right has no room. */
  function placeBeside(anchor: HTMLElement) {
    fly.hidden = false;
    const box = card.getBoundingClientRect();
    const at = anchor.getBoundingClientRect();
    const right = box.right + 8;
    const left = right + fly.offsetWidth <= window.innerWidth - 8 ? right : Math.max(8, box.left - 8 - fly.offsetWidth);
    const top = Math.min(at.top - 14, window.innerHeight - fly.offsetHeight - 8);
    fly.style.left = `${left}px`;
    fly.style.top = `${Math.max(8, top)}px`;
  }

  return {
    attach: (row: HTMLElement, key: string) => peek.arm(row, key),
    /** The needs or agents changed: an open card shows the new state. */
    redraw: () => peek.shown() && draw(),
  };
}
