import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightTree } from "@lezer/highlight";
import { el } from "./dom.ts";
import { highlightStyle } from "./highlight.ts";
import { current } from "./theme.ts";

const ALIASES: Record<string, string> = { ts: "typescript", js: "javascript", sh: "shell", bash: "shell", zsh: "shell", yml: "yaml", py: "python", rs: "rust", md: "markdown" };

/** Colours a code block with the editor's grammar for its language, once that grammar is loaded. */
export async function highlightInto(node: HTMLElement, code: string, lang: string) {
  const name = ALIASES[lang.toLowerCase()] ?? lang;
  const description = LanguageDescription.matchLanguageName(languages, name, true);
  if (!description) return;
  const support = await description.load();
  const tree = support.language.parser.parse(code);
  const style = highlightStyle(current());
  const fragment = document.createDocumentFragment();
  let at = 0;
  highlightTree(tree, style, (from, to, classes) => {
    if (from > at) fragment.append(code.slice(at, from));
    fragment.append(el("span", { class: classes }, code.slice(from, to)));
    at = to;
  });
  if (at < code.length) fragment.append(code.slice(at));
  node.replaceChildren(fragment);
}

/**
 * Enough markdown for a conversation: fenced code, inline code, bold, italic, links, lists
 * and headings. Everything else is a paragraph with its line breaks kept. No HTML passes
 * through; the text is what the model wrote, rendered, not interpreted.
 */
export function markdown(source: string): DocumentFragment {
  const out = document.createDocumentFragment();
  // The task pills are added at the end, over the rendered nodes: see `fillTaskPills`.
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    const fence = /^```(\w+)?\s*$/.exec(line);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index]!)) code.push(lines[index++]!);
      index += 1;
      const block = el("code", {}, code.join("\n"));
      out.append(el("pre.md-code", { "data-lang": fence[1] ?? "" }, block));
      if (fence[1]) void highlightInto(block, code.join("\n"), fence[1]);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      out.append(el(`h${Math.min(4, heading[1]!.length + 1)}.md-h`, {}, ...inline(heading[2]!)));
      index += 1;
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const list = el(ordered ? "ol.md-list" : "ul.md-list");
      while (index < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[index]!)) {
        list.append(el("li", {}, ...inline(lines[index]!.replace(/^\s*([-*+]|\d+[.)])\s+/, ""))));
        index += 1;
      }
      out.append(list);
      continue;
    }
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && lines[index]!.trim() && !/^```|^#{1,6}\s|^\s*([-*+]|\d+[.)])\s+/.test(lines[index]!))
      paragraph.push(lines[index++]!);
    const p = el("p.md-p");
    paragraph.forEach((text, i) => {
      if (i) p.append(el("br"));
      p.append(...inline(text));
    });
    out.append(p);
  }
  fillTaskPills(out);
  return out;
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*|_[^_]+_)|(\[[^\]]+\]\([^)]+\))|(https?:\/\/[^\s<>)]+)/g;

/**
 * `#20` in a message is a task, and reads as one: the pill carries its title and its state, the
 * details sit on it for a hover, and a click opens it. An id nothing answers to stays plain text —
 * a dead chip would say more than is known. The host fills this in (`taskPills`), so this file
 * still renders without knowing where tasks come from.
 */
export interface TaskRef {
  readonly id: number;
  readonly title: string;
  readonly status: string;
  readonly owner: string;
  readonly due: string | null;
  readonly nextAction?: string;
}
let findTask: (id: number) => TaskRef | undefined = () => undefined;
let openTask: ((id: number) => void) | undefined;
/** Gives the pill its hover card; without one it is still a button that opens the task. */
let armPill: ((pill: HTMLElement, task: TaskRef) => void) | undefined;
export function taskPills(find: (id: number) => TaskRef | undefined, open: (id: number) => void, arm?: (pill: HTMLElement, task: TaskRef) => void) {
  findTask = find;
  openTask = open;
  armPill = arm;
}

/** Open, waiting on him, or closed: the three states a pill is coloured by. */
const PILL_STATE: Readonly<Record<string, string>> = { waiting_user: "warn", done: "done", dropped: "done" };

/** Where an id must not be touched: code, links, and a pill already made. */
const NO_PILLS = "code, pre, a, .task-pill, .task-ref";
const TASK_IN_TEXT = /(^|[\s([{,:;])#(\d{1,6})\b/g;

/**
 * Task ids become pills **after** the markdown is rendered, by walking the text nodes: an id
 * inside bold, a list item or a heading is markup by then, and a transform over the source text
 * would never see it (`**#87**` stayed plain while a bare `#87` became a chip). One walk, over
 * whatever a body was rendered into, so history and the live stream cannot drift apart.
 *
 * An id no task answers to is left as a placeholder rather than a chip, and upgraded by a later
 * pass once the host knows that task — which is also how a row drawn before the task index
 * arrived gets its pill.
 */
export function fillTaskPills(root: ParentNode = document) {
  for (const ref of [...root.querySelectorAll<HTMLElement>(".task-ref[data-task]")]) {
    const pill = taskPill(Number(ref.dataset.task));
    if (pill) ref.replaceWith(pill);
  }
  const walker = document.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => ((node.parentElement?.closest(NO_PILLS) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) as number),
  });
  const texts: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) if (/#\d/.test(node.textContent ?? "")) texts.push(node as Text);
  for (const text of texts) {
    const source = text.textContent ?? "";
    const out = document.createDocumentFragment();
    let last = 0;
    for (const match of source.matchAll(TASK_IN_TEXT)) {
      const at = (match.index ?? 0) + match[1]!.length;
      const id = Number(match[2]);
      out.append(source.slice(last, at));
      out.append(taskPill(id) ?? el("span.task-ref", { "data-task": String(id) }, `#${id}`));
      last = at + 1 + match[2]!.length;
    }
    if (!last) continue;
    out.append(source.slice(last));
    text.replaceWith(out);
  }
}

function taskPill(id: number) {
  const task = findTask(id);
  if (!task) return undefined;
  const pill = el(
    "button.task-pill",
    {
      class: `task-pill ${PILL_STATE[task.status] ?? "open"}`,
      // A pill inside a row whose own card is armed: the click is the pill's, not the row's.
      onclick: (event: Event) => {
        event.stopPropagation();
        openTask?.(task.id);
      },
    },
    `#${task.id} ${task.title.slice(0, 60)}`,
  );
  armPill?.(pill, task);
  return pill;
}

/** One line of markdown, inline marks only: for a summary line, a card head, a tooltip. */
export function inline(text: string): (Node | string)[] {
  const parts: (Node | string)[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0;
    if (at > last) parts.push(text.slice(last, at));
    const [whole, code, bold, italic, link, url] = match;
    if (code) parts.push(el("code.md-inline", {}, code.slice(1, -1)));
    else if (bold) parts.push(el("strong", {}, ...inline(bold.slice(2, -2))));
    else if (italic) parts.push(el("em", {}, ...inline(italic.slice(1, -1))));
    else if (link) {
      const [, label = "", href = ""] = /\[([^\]]+)\]\(([^)]+)\)/.exec(link) ?? [];
      parts.push(el("a", { href, target: "_blank", rel: "noreferrer" }, ...inline(label)));
    } else if (url) parts.push(el("a", { href: url, target: "_blank", rel: "noreferrer" }, url));
    last = at + whole.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
