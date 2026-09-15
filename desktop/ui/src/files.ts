import { entries } from "./api.ts";
import { el } from "./dom.ts";
import { icon } from "./icons.ts";
import type { Entry } from "./types.ts";

/** The file browser: one lazily expanded tree for the selected project. */
export function tree(root: string, open: (path: string) => void, current?: () => string | undefined) {
  const node = el("div.tree");
  void level(node, root, open, 0, current);
  return node;
}

async function level(parent: HTMLElement, path: string, open: (path: string) => void, depth: number, current?: () => string | undefined) {
  let listing: Entry[] = [];
  try {
    listing = await entries(path);
  } catch {
    parent.append(el("p.hint", {}, "not available offline"));
    return;
  }
  const sorted = [...listing].sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
  for (const entry of sorted) {
    if (entry.name.startsWith(".") && entry.name !== ".env") continue;
    const children = el("div.children", { hidden: true });
    const chevron = entry.directory ? icon("chevron", 12) : undefined;
    const row = el(
      "button.file",
      {
        class: `file${entry.directory ? " dir" : ""}${current?.() === entry.path ? " current" : ""}`,
        style: `padding-left:${8 + depth * 12}px`,
        title: entry.path,
        onclick: async () => {
          if (!entry.directory) {
            parent.closest(".tree")?.querySelectorAll(".file.current").forEach((n) => n.classList.remove("current"));
            row.classList.add("current");
            return open(entry.path);
          }
          const collapsed = children.hasAttribute("hidden");
          if (collapsed) {
            children.removeAttribute("hidden");
            chevron?.classList.add("open");
            if (!children.childElementCount) await level(children, entry.path, open, depth + 1, current);
          } else {
            children.setAttribute("hidden", "");
            chevron?.classList.remove("open");
          }
        },
      },
      chevron ?? el("span.spacer"),
      el("span.label", {}, entry.name),
    );
    parent.append(row, children);
  }
}
