import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightTree } from "@lezer/highlight";
import { el } from "./dom.ts";
import { fillMoney } from "./money.ts";
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
    // `> quoted` is a quote, not a line that starts with an angle bracket.
    if (/^\s*>\s?/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index]!)) quoted.push(lines[index++]!.replace(/^\s*>\s?/, ""));
      // A quote can hold anything a message can, so it is rendered as one.
      out.append(el("blockquote.md-quote", {}, markdown(quoted.join("\n"))));
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
  fillMoney(out);
  return out;
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*|_[^_]+_)|(\[[^\]]+\]\([^)]+\))|(https?:\/\/[^\s<>)]+)/g;

/**
 * What a message can point at, written as a sigil and a name: `#87` a task, `@dev` an agent,
 * `?53` a decision waiting on him, `^1904` a row of the log. Each becomes a chip carrying what
 * it is, its details on a hover and the thing itself on a click; a reference nothing answers to
 * stays plain text, since a dead chip would claim more than is known. The host resolves them
 * (`referencePills`), so this file still renders without knowing where any of it comes from.
 */
export type RefKind = "task" | "agent" | "ask" | "message";

export interface Reference {
  readonly kind: RefKind;
  /** What the chip says. */
  readonly label: string;
  /** How it is coloured: open (the default), waiting on him, or closed. */
  readonly state?: "open" | "warn" | "done";
}

const SIGILS: Readonly<Record<string, RefKind>> = { "#": "task", "@": "agent", "?": "ask", "^": "message" };

let findRef: (kind: RefKind, id: string) => Reference | undefined = () => undefined;
let openRef: ((kind: RefKind, id: string) => void) | undefined;
/** Gives a chip its hover card; without one it is still a button that opens the thing. */
let armRef: ((pill: HTMLElement, kind: RefKind, id: string) => void) | undefined;

export function referencePills(
  find: (kind: RefKind, id: string) => Reference | undefined,
  open: (kind: RefKind, id: string) => void,
  arm?: (pill: HTMLElement, kind: RefKind, id: string) => void,
) {
  findRef = find;
  openRef = open;
  armRef = arm;
}

/** Where a reference must not be touched: code, links, and a chip already made. */
const NO_PILLS = "code, pre, a, .ref-pill, .ref-text";
/** A sigil only reads as one at the start of a word, so `a@b.com` and `x^2` are left alone. */
const REF_IN_TEXT = /(^|[\s([{,:;])([#@?^])([a-z0-9][a-z0-9-]{0,39})\b/gi;

/**
 * References become chips **after** the markdown is rendered, by walking the text nodes: one
 * inside bold, a list item or a heading is markup by then, and a transform over the source text
 * would never see it (`**#87**` stayed plain while a bare `#87` became a chip). One walk, over
 * whatever a body was rendered into, so history and the live stream cannot drift apart.
 *
 * What the host cannot resolve yet is left as a placeholder and upgraded by a later pass — which
 * is how a row drawn before the task index arrived still gets its chip.
 */
export function fillTaskPills(root: ParentNode = document) {
  for (const ref of [...root.querySelectorAll<HTMLElement>(".ref-text[data-ref]")]) {
    const [kind, id] = (ref.dataset.ref ?? "").split(":");
    const pill = kind && id ? refPill(kind as RefKind, id) : undefined;
    if (pill) ref.replaceWith(pill);
  }
  const walker = document.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => ((node.parentElement?.closest(NO_PILLS) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) as number),
  });
  const texts: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) if (/[#@?^][a-z0-9]/i.test(node.textContent ?? "")) texts.push(node as Text);
  for (const text of texts) {
    const source = text.textContent ?? "";
    const out = document.createDocumentFragment();
    let last = 0;
    for (const match of source.matchAll(REF_IN_TEXT)) {
      const [whole, before = "", sigil = "", id = ""] = match;
      const kind = SIGILS[sigil];
      // A task, an ask and a message are numbers; an agent is a slug.
      if (!kind || ((kind === "task" || kind === "ask" || kind === "message") && !/^\d+$/.test(id))) continue;
      const at = (match.index ?? 0) + before.length;
      out.append(source.slice(last, at));
      out.append(refPill(kind, id) ?? el("span.ref-text", { "data-ref": `${kind}:${id}` }, `${sigil}${id}`));
      last = at + whole.length - before.length;
    }
    if (!last) continue;
    out.append(source.slice(last));
    text.replaceWith(out);
  }
}

function refPill(kind: RefKind, id: string) {
  const found = findRef(kind, id);
  if (!found) return undefined;
  const pill = el(
    "button.ref-pill",
    {
      class: `ref-pill ${kind} ${found.state ?? "open"}`,
      // A chip inside a row whose own card is armed: the click is the chip's, not the row's.
      onclick: (event: Event) => {
        event.stopPropagation();
        openRef?.(kind, id);
      },
    },
    found.label,
  );
  armRef?.(pill, kind, id);
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
