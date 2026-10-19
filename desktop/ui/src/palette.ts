import { clear, closeSheet, el } from "./dom.ts";
import { icon, type IconName } from "./icons.ts";

export interface Command {
  readonly id: string;
  readonly title: string;
  readonly group: string;
  readonly icon?: IconName;
  readonly hint?: string;
  readonly run: () => void;
}

const LIMIT = 40;

export interface PaletteOptions {
  /** Groups the list is narrowed to, shown as pills in the bar; Backspace on an empty box takes the last one off. */
  readonly filters?: readonly string[];
}

/** Subsequence match with a score: word starts and runs of consecutive hits count for more. */
function score(query: string, text: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t.includes(q)) return 100 + (t.startsWith(q) ? 50 : 0) - t.length / 100;
  let qi = 0;
  let total = 0;
  let streak = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      streak += 1;
      total += streak * 2 + (i === 0 || /[\s/._-]/.test(t[i - 1]!) ? 5 : 0);
      qi += 1;
    } else streak = 0;
  }
  return qi === q.length ? total - t.length / 100 : 0;
}

/**
 * ⌘K: one box for everything — actions, projects, threads, files. The list is whatever the
 * caller provides at the moment it opens, so it is always current.
 */
export function palette(load: () => Promise<Command[]>, options: PaletteOptions = {}) {
  // ⌘K again while it is open closes it: the key is a toggle.
  const open = document.querySelector<HTMLDialogElement>("dialog.palette");
  if (open) return closeSheet(open);
  const input = el("input", { placeholder: "Search actions, projects, threads, files…", spellcheck: false }) as HTMLInputElement;
  const list = el("div.palette-list");
  const pills = el("span.palette-pills");
  const sheet = el("dialog.sheet.palette", {}, el("div.palette-box", {}, el("div.palette-input", {}, icon("zap", 14), pills, input), list)) as HTMLDialogElement;
  let commands: Command[] = [];
  let shown: Command[] = [];
  let cursor = 0;
  let filters = [...(options.filters ?? [])];

  const PLURAL: Record<string, string> = { thread: "threads", project: "projects", file: "files", action: "actions", view: "views", setting: "settings", shortcut: "shortcuts" };
  /** Groups the typed word could mean, not yet on: "thr" offers threads. */
  const filterHints = (query: string) => {
    const q = query.toLowerCase();
    if (!q) return [];
    return [...new Set(commands.map((c) => c.group))].filter((group) => !filters.includes(group) && (group.startsWith(q) || (PLURAL[group] ?? "").startsWith(q)));
  };
  const addFilter = (group: string) => {
    filters = [...filters, group];
    input.value = "";
    drawPills();
    render();
    input.focus();
  };
  const drawPills = () => {
    clear(pills, ...filters.map((group) => el("span.palette-pill", {}, el("span", {}, PLURAL[group] ?? group), el("button", { type: "button", title: "remove (⌫)", onclick: () => dropFilter(group) }, icon("x", 10)))));
    input.placeholder = filters.length ? `Search ${filters.map((g) => PLURAL[g] ?? g).join(", ")}…` : "Search actions, projects, threads, files…";
  };
  const dropFilter = (group: string) => {
    filters = filters.filter((g) => g !== group);
    drawPills();
    render();
    input.focus();
  };
  drawPills();

  const close = () => closeSheet(sheet);
  const run = (command: Command | undefined) => {
    if (!command) return;
    close();
    command.run();
  };
  /** What the list offers: a filter to apply (Tab or Enter) first, then the commands. */
  let hints: string[] = [];
  const render = () => {
    const query = input.value.trim();
    hints = filterHints(query);
    shown = commands
      .filter((command) => !filters.length || filters.includes(command.group))
      .map((command) => ({ command, score: score(query, `${command.group} ${command.title}`) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, LIMIT)
      .map((entry) => entry.command);
    cursor = 0;
    const rows = [
      ...hints.map((group, index) =>
        el(
          "button.palette-row.filter-row",
          { class: `palette-row filter-row${index === cursor ? " active" : ""}`, onclick: () => addFilter(group), onmousemove: () => highlight(index) },
          icon("search", 13),
          el("span.label", {}, "Filter: ", el("b", {}, PLURAL[group] ?? group)),
          el("span.dim.ellipsis", {}, `only ${PLURAL[group] ?? group}`),
          el("kbd.key", { title: "Tab" }, "⇥"),
        ),
      ),
      ...shown.map((command, i) => {
        const index = hints.length + i;
        return el(
          "button.palette-row",
          { class: `palette-row${index === cursor ? " active" : ""}`, onclick: () => run(command), onmousemove: () => highlight(index) },
          command.icon ? icon(command.icon, 13) : el("span.spacer"),
          el("span.label.ellipsis", {}, command.title),
          command.hint ? el("span.dim.ellipsis", {}, command.hint) : undefined,
          filters.includes(command.group) ? undefined : el("span.tag", {}, command.group),
        );
      }),
    ];
    clear(list, ...rows);
    if (!rows.length) list.append(el("p.hint", {}, "nothing matches"));
  };
  /** The row under the cursor: a filter to apply, or a command to run. */
  const pick = () => (cursor < hints.length ? addFilter(hints[cursor]!) : run(shown[cursor - hints.length]));
  const highlight = (index: number) => {
    cursor = index;
    list.querySelectorAll(".palette-row").forEach((row, i) => row.classList.toggle("active", i === cursor));
    list.children[cursor]?.scrollIntoView({ block: "nearest" });
  };

  input.addEventListener("input", render);
  sheet.addEventListener("keydown", (event) => {
    if (event.key === "Backspace" && !input.value && filters.length) dropFilter(filters[filters.length - 1]!);
    else if (event.key === "Escape") close();
    else if (event.key === "ArrowDown") highlight(Math.min(hints.length + shown.length - 1, cursor + 1));
    else if (event.key === "ArrowUp") highlight(Math.max(0, cursor - 1));
    else if (event.key === "Enter") pick();
    else if (event.key === "Tab" && hints.length) addFilter(hints[cursor < hints.length ? cursor : 0]!);
    else return;
    event.preventDefault();
  });
  sheet.addEventListener("click", (event) => event.target === sheet && close());
  sheet.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  sheet.addEventListener("close", () => sheet.isConnected && sheet.remove());

  document.body.append(sheet);
  sheet.showModal();
  input.focus();
  list.append(el("p.hint", {}, "…"));
  void load().then((loaded) => {
    commands = loaded;
    render();
  });
}
