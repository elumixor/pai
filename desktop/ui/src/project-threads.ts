import { threadsIn } from "./api.ts";
import { clear, el, skeleton, stamp } from "./dom.ts";
import { icon } from "./icons.ts";
import type { DiskSession } from "./types.ts";

/**
 * A repo's conversations: every Claude Code session held in it, newest first, the finished ones
 * included. The tree only shows a thread while it runs, which is right there and wrong here — a
 * repo's value is the history of what was said in it, and he opens a project to find yesterday's
 * conversation without remembering its title.
 */

/** Enough to scan, not enough to render hundreds; "Show more" asks for another page. */
const PAGE = 25;

export interface ProjectThreadsContext {
  readonly openThread: (id: string) => void;
  /** A box in this repo instead: for when none of these is the conversation he wants. */
  readonly newThread: () => void;
}

export function projectThreads(path: string, ctx: ProjectThreadsContext) {
  const list = el("div.thread-list", {}, skeleton("lines", 5));
  const node = el("div.agent-view", {}, list);
  let limit = PAGE;
  let disposed = false;

  const row = (t: DiskSession) =>
    el(
      "button.row.pill.thread-row",
      { title: `${t.title}\n${t.cwd}`, onclick: () => ctx.openThread(t.sessionId) },
      el("span.pill-line", {}, icon("message", 11), el("span.ellipsis.pill-text", {}, t.title || t.sessionId.slice(0, 6)), el("span.when", {}, stamp(t.lastActivity))),
    );

  async function draw() {
    const found = await threadsIn(path, limit).catch(() => [] as DiskSession[]);
    if (disposed) return;
    if (!found.length) {
      clear(list, el("p.info-dim", {}, "No conversations in this repo yet."), el("button.opt", { onclick: ctx.newThread }, "Start one"));
      return;
    }
    clear(list, ...found.map(row));
    // A full page means there may be more; the server reads the directory newest first.
    if (found.length >= limit)
      list.append(
        el("button.opt.more-threads", {
          onclick: () => {
            limit += PAGE;
            void draw();
          },
        }, "Show more"),
      );
  }

  void draw();
  return { node, dispose: () => (disposed = true) };
}
