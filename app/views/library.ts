import { clear, el, json } from "../dom.ts";
import type { Entry, Memory } from "../types.ts";

/** Instructions and long-term memory: what pai has been told, and what it chose to keep. */
export async function library(side: HTMLElement, pane: HTMLElement) {
  const [docs, memories] = await Promise.all([json<Entry[]>("/docs"), json<Memory[]>("/memory")]);

  const showDoc = async (doc: Entry) => {
    const file = await json<{ text: string; truncated: boolean }>(`/file?path=${encodeURIComponent(doc.path)}`);
    clear(pane, el("h3", {}, doc.name), el("pre", {}, file.text + (file.truncated ? "\n\n… truncated" : "")));
  };

  const showMemory = (memory: Memory) =>
    clear(
      pane,
      el("h3", {}, `${memory.name} · ${memory.type}`),
      el("p.empty", {}, memory.description),
      el("pre", {}, memory.body),
    );

  clear(
    side,
    el("h2", {}, "Instructions"),
    ...docs.map((doc) => el("button.row", { onclick: () => void showDoc(doc) }, el("span.grow", {}, doc.name))),
    el("h2", {}, "Memory"),
    ...(memories.length
      ? memories.map((memory) =>
          el("button.row", { onclick: () => showMemory(memory) }, el("span.grow", {}, memory.name), el("span.dim", {}, memory.type)),
        )
      : [el("p.empty", {}, "nothing saved yet")]),
  );

  if (docs[0]) await showDoc(docs[0]);
}
