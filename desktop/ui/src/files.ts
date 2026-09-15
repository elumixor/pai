import { entries } from "./api.ts";
import { el } from "./dom.ts";
import { icon } from "./icons.ts";
import type { Entry } from "./types.ts";

interface Branch {
  readonly row: HTMLElement;
  readonly expand: () => Promise<void>;
}

export interface Tree extends HTMLElement {
  /** Expands the directories down to a file, scrolls to it and marks it as the current one. */
  reveal: (path: string) => Promise<void>;
}

/** The file browser: one lazily expanded tree for the selected project. */
export function tree(root: string, open: (path: string) => void, current?: () => string | undefined): Tree {
  const node = el("div.tree") as Tree;
  const branches = new Map<string, Branch>();
  const loaded = level(node, root, open, 0, current, branches);
  node.reveal = async (path: string) => {
    await loaded;
    if (!path.startsWith(`${root}/`)) return;
    const parts = path.slice(root.length + 1).split("/");
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      dir = `${dir}/${part}`;
      await branches.get(dir)?.expand();
    }
    const row = branches.get(path)?.row;
    if (!row) return;
    node.querySelectorAll(".file.current").forEach((n) => n.classList.remove("current"));
    row.classList.add("current");
    row.scrollIntoView({ block: "center" });
    row.focus();
  };
  return node;
}

async function level(parent: HTMLElement, path: string, open: (path: string) => void, depth: number, current: (() => string | undefined) | undefined, branches: Map<string, Branch>) {
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
    let loading: Promise<void> | undefined;
    const expand = async () => {
      children.removeAttribute("hidden");
      chevron?.classList.add("open");
      if (!children.childElementCount) await (loading ??= level(children, entry.path, open, depth + 1, current, branches));
    };
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
          if (collapsed) await expand();
          else {
            children.setAttribute("hidden", "");
            chevron?.classList.remove("open");
          }
        },
      },
      chevron ?? el("span.spacer"),
      el("span.label", {}, entry.name),
    );
    branches.set(entry.path, { row, expand });
    parent.append(row, children);
  }
}
