import { entries, file } from "./api.ts";
import { basename, clear, el } from "./dom.ts";
import type { Entry } from "./types.ts";

/** The file browser in the sidebar: one lazily expanded tree per project. */
export function tree(root: string, open: (path: string) => void) {
  const node = el("div.tree");
  void level(node, root, open, 0);
  return node;
}

async function level(parent: HTMLElement, path: string, open: (path: string) => void, depth: number) {
  let listing: Entry[] = [];
  try {
    listing = await entries(path);
  } catch {
    parent.append(el("p.empty", {}, "not available offline"));
    return;
  }
  for (const entry of listing) {
    if (entry.name.startsWith(".") && entry.name !== ".env") continue;
    const children = el("div.children", { hidden: true });
    const row = el(
      "button.row.file",
      {
        style: `padding-left:${8 + depth * 12}px`,
        onclick: async () => {
          if (!entry.directory) return open(entry.path);
          const collapsed = children.hasAttribute("hidden");
          if (collapsed) {
            children.removeAttribute("hidden");
            if (!children.childElementCount) await level(children, entry.path, open, depth + 1);
          } else children.setAttribute("hidden", "");
        },
      },
      el("span.glyph", {}, entry.directory ? "›" : "·"),
      el("span.grow", {}, entry.name),
    );
    parent.append(row, children);
  }
}

/** The viewer: text as it is, with line numbers, and no editing — that is a session's job. */
export async function viewer(pane: HTMLElement, path: string) {
  clear(pane, el("header.pane-head", {}, el("h2", {}, basename(path)), el("span.dim", {}, path)));
  try {
    const { content, truncated } = await file(path);
    const lines = content.split("\n");
    pane.append(
      el(
        "div.code",
        {},
        el("pre.gutter", {}, lines.map((_, index) => String(index + 1)).join("\n")),
        el("pre.source", {}, content),
      ),
      truncated ? el("p.empty", {}, "truncated") : el("span"),
    );
  } catch {
    pane.append(el("p.empty", {}, "This file is not cached and the daemon is not reachable."));
  }
}
