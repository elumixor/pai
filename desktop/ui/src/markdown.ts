import { el } from "./dom.ts";

/**
 * Enough markdown for a conversation: fenced code, inline code, bold, italic, links, lists
 * and headings. Everything else is a paragraph with its line breaks kept. No HTML passes
 * through; the text is what the model wrote, rendered, not interpreted.
 */
export function markdown(source: string): DocumentFragment {
  const out = document.createDocumentFragment();
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
      out.append(el("pre.md-code", { "data-lang": fence[1] ?? "" }, el("code", {}, code.join("\n"))));
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
  return out;
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*|_[^_]+_)|(\[[^\]]+\]\([^)]+\))|(https?:\/\/[^\s<>)]+)/g;

function inline(text: string): (Node | string)[] {
  const parts: (Node | string)[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0;
    if (at > last) parts.push(text.slice(last, at));
    const [whole, code, bold, italic, link, url] = match;
    if (code) parts.push(el("code.md-inline", {}, code.slice(1, -1)));
    else if (bold) parts.push(el("strong", {}, bold.slice(2, -2)));
    else if (italic) parts.push(el("em", {}, italic.slice(1, -1)));
    else if (link) {
      const [, label = "", href = ""] = /\[([^\]]+)\]\(([^)]+)\)/.exec(link) ?? [];
      parts.push(el("a", { href, target: "_blank", rel: "noreferrer" }, label));
    } else if (url) parts.push(el("a", { href: url, target: "_blank", rel: "noreferrer" }, url));
    last = at + whole.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
