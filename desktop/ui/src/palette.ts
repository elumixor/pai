import { clear, el } from "./dom.ts";
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
export function palette(load: () => Promise<Command[]>) {
  const input = el("input", { placeholder: "Search actions, projects, threads, files…", spellcheck: false }) as HTMLInputElement;
  const list = el("div.palette-list");
  const sheet = el("dialog.sheet.palette", {}, el("div.palette-box", {}, el("div.palette-input", {}, icon("zap", 14), input), list)) as HTMLDialogElement;
  let commands: Command[] = [];
  let shown: Command[] = [];
  let cursor = 0;

  const close = () => {
    sheet.close();
    sheet.remove();
  };
  const run = (command: Command | undefined) => {
    if (!command) return;
    close();
    command.run();
  };
  const render = () => {
    const query = input.value.trim();
    shown = commands
      .map((command) => ({ command, score: score(query, `${command.group} ${command.title}`) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, LIMIT)
      .map((entry) => entry.command);
    cursor = 0;
    clear(
      list,
      ...shown.map((command, index) =>
        el(
          "button.palette-row",
          { class: `palette-row${index === cursor ? " active" : ""}`, onclick: () => run(command), onmousemove: () => highlight(index) },
          command.icon ? icon(command.icon, 13) : el("span.spacer"),
          el("span.label.ellipsis", {}, command.title),
          command.hint ? el("span.dim.ellipsis", {}, command.hint) : undefined,
          el("span.tag", {}, command.group),
        ),
      ),
    );
    if (!shown.length) list.append(el("p.hint", {}, "nothing matches"));
  };
  const highlight = (index: number) => {
    cursor = index;
    list.querySelectorAll(".palette-row").forEach((row, i) => row.classList.toggle("active", i === cursor));
    list.children[cursor]?.scrollIntoView({ block: "nearest" });
  };

  input.addEventListener("input", render);
  sheet.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
    else if (event.key === "ArrowDown") highlight(Math.min(shown.length - 1, cursor + 1));
    else if (event.key === "ArrowUp") highlight(Math.max(0, cursor - 1));
    else if (event.key === "Enter") run(shown[cursor]);
    else return;
    event.preventDefault();
  });
  sheet.addEventListener("click", (event) => event.target === sheet && close());
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
