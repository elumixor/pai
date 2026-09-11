import { bytes, clear, el, json } from "../dom.ts";
import type { Entry } from "../types.ts";

interface Root {
  readonly name: string;
  readonly path: string;
}

export async function files(side: HTMLElement, pane: HTMLElement) {
  const roots = await json<Root[]>("/roots");
  let current = roots[0]?.path ?? "";

  const show = async (path: string) => {
    current = path;
    const entries = await json<Entry[]>(`/files?path=${encodeURIComponent(path)}`);
    const root = roots.find((r) => path === r.path || path.startsWith(`${r.path}/`));
    const tail = root ? path.slice(root.path.length).split("/").filter(Boolean) : [];

    const crumbs = el(
      "div.crumbs",
      {},
      el("button", { onclick: () => void show(root?.path ?? path) }, root?.name ?? path),
      ...tail.flatMap((part, index) => [
        el("span", {}, "/"),
        el(
          "button",
          { onclick: () => void show(`${root?.path ?? ""}/${tail.slice(0, index + 1).join("/")}`) },
          part,
        ),
      ]),
    );

    clear(
      pane,
      crumbs,
      el(
        "div.list",
        {},
        ...entries.map((entry) =>
          el(
            "button.row",
            { onclick: () => void (entry.directory ? show(entry.path) : open(entry)) },
            el("span.grow", {}, `${entry.directory ? "📁 " : ""}${entry.name}`),
            el("span.dim", {}, entry.directory ? "" : bytes(entry.size)),
          ),
        ),
      ),
    );
  };

  const open = async (entry: Entry) => {
    const file = await json<{ text: string; truncated: boolean }>(`/file?path=${encodeURIComponent(entry.path)}`);
    clear(
      pane,
      el("div.crumbs", {}, el("button", { onclick: () => void show(current) }, "← back"), el("span", {}, entry.path)),
      el("pre", {}, file.text + (file.truncated ? "\n\n… truncated" : "")),
    );
  };

  clear(
    side,
    el("h2", {}, "Roots"),
    ...roots.map((root) => el("button.row", { onclick: () => void show(root.path) }, el("span.grow", {}, root.name), el("span.dim", {}, root.path))),
  );

  await show(current);
}
