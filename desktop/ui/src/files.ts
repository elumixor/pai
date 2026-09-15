import { entries, file } from "./api.ts";
import { basename, clear, el } from "./dom.ts";
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
        style: `padding-left:${10 + depth * 14}px`,
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
      icon(entry.directory ? "folder" : "file", 13),
      el("span.label", {}, entry.name),
    );
    parent.append(row, children);
  }
}

const EXT_LANG: Record<string, string> = { ts: "ts", tsx: "tsx", js: "js", json: "json", md: "md", css: "css", html: "html", rs: "rust", py: "py", swift: "swift", sh: "sh", yml: "yaml", yaml: "yaml", toml: "toml" };

/** The viewer: text as it is, with line numbers, and no editing — that is a session's job. */
export async function viewer(pane: HTMLElement, path: string) {
  const ext = path.split(".").pop() ?? "";
  clear(
    pane,
    el("header.panel-head", {}, icon("file", 14), el("h2", {}, basename(path)), el("span.dim.ellipsis", {}, path), el("span.grow"), el("span.tag", {}, EXT_LANG[ext] ?? ext)),
  );
  try {
    const { text, truncated } = await file(path);
    const lines = text.split("\n");
    pane.append(el("div.code", {}, el("pre.gutter", {}, lines.map((_, index) => String(index + 1)).join("\n")), el("pre.source", {}, text)));
    if (truncated) pane.append(el("p.hint", {}, "truncated"));
  } catch {
    pane.append(el("div.empty", {}, el("p", {}, "This file is not cached and the daemon is not reachable.")));
  }
}

export function emptyViewer(pane: HTMLElement) {
  clear(
    pane,
    el("header.panel-head", {}, icon("code", 14), el("h2", {}, "Editor")),
    el("div.empty", {}, icon("file", 28), el("p", {}, "Pick a file on the left to read it here."), el("p.dim", {}, "Editing is a thread's job: ask it.")),
  );
}
