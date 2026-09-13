import { baseUrl, flush, follow, isOnline, lastError, onConnection, outbox, resolveBase, send, status } from "./api.ts";
import { clear, el } from "./dom.ts";
import { viewer } from "./files.ts";
import { settingsView } from "./settings.ts";
import { sidebar } from "./sidebar.ts";
import { terminal } from "./terminal.ts";
import { thread } from "./thread.ts";
import type { SessionSummary } from "./types.ts";

const side = document.getElementById("side")!;
const pane = document.getElementById("pane")!;
const state = document.getElementById("state")!;

/** Whatever the pane is showing has to be torn down before the next thing replaces it. */
let dispose: () => void = () => {};
const show = async (open: () => Promise<(() => void) | void> | (() => void) | void) => {
  dispose();
  dispose = (await open()) ?? (() => {});
};

const refreshSidebar = () =>
  void sidebar(side, handlers).catch(() => {
    clear(side, el("div.groups", {}, unreachable()));
  });

const handlers = {
  openThread: (session: SessionSummary) => void show(() => thread(pane, session)),
  openFile: (path: string) => void show(() => viewer(pane, path)),
  openTerminal: (project?: string) => void show(() => terminal(pane, project)),
};

document.getElementById("settings")!.addEventListener("click", () => void show(() => settingsView(pane)));
document.getElementById("refresh")!.addEventListener("click", refreshSidebar);
document.getElementById("new-task")!.addEventListener("click", async () => {
  const title = prompt("Task title");
  if (!title) return;
  const text = prompt("First message") ?? "";
  await send("/task", { title, text });
  refreshSidebar();
});

/** Offline is usually one of two things: the wrong address, or a daemon that is not running. */
function unreachable() {
  return el(
    "div.notice",
    {},
    el("p", {}, `Cannot reach ${baseUrl()}.`),
    lastError ? el("p.dim", {}, lastError) : undefined,
    el(
      "div.row-inline",
      {},
      el("button.action", { onclick: refreshSidebar }, "Retry"),
      el("button.action", { onclick: () => void show(() => settingsView(pane)) }, "Change address"),
    ),
  );
}

onConnection((online) => {
  const queued = outbox().length;
  state.className = online ? "state online" : "state offline";
  state.textContent = online ? (queued ? `online · ${queued} queued` : "online") : `offline${queued ? ` · ${queued} queued` : ""}`;
});

void (async () => {
  await resolveBase();
  try {
    const health = await status();
    document.title = `pai · ${health.host.hostname}`;
  } catch {
    /* offline is a normal way to start */
  }
  refreshSidebar();
  if (isOnline()) void flush();
  // Session states change the sidebar; the thread view has its own stream for messages.
  follow(undefined, (event) => {
    if (event.kind.startsWith("session.started") || event.kind === "session.turn_end" || event.kind === "session.ended")
      refreshSidebar();
  });
})();
