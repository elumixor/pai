import { clear, el, json } from "./dom.ts";
import type { Status } from "./types.ts";
import { overview } from "./views/overview.ts";
import { threads, stopThreads } from "./views/threads.ts";
import { terminals, stopTerminals } from "./views/terminals.ts";
import { files } from "./views/files.ts";
import { library } from "./views/library.ts";

type Render = (side: HTMLElement, pane: HTMLElement) => Promise<void>;

interface Tab {
  readonly name: string;
  readonly render: Render;
  readonly sidebar: boolean;
}

const tabs: readonly Tab[] = [
  { name: "Overview", render: (_side, pane) => overview(pane), sidebar: false },
  { name: "Threads", render: threads, sidebar: true },
  { name: "Terminals", render: terminals, sidebar: true },
  { name: "Files", render: files, sidebar: true },
  { name: "Library", render: library, sidebar: true },
];

const view = document.getElementById("view");
const nav = document.getElementById("tabs");
const summary = document.getElementById("summary");
if (!view || !nav || !summary) throw new Error("the page is missing its shell");

let current = tabs[0] as Tab;

async function show(tab: Tab) {
  stopThreads();
  if (tab.name !== "Terminals") stopTerminals();
  current = tab;

  for (const button of nav.querySelectorAll("button")) button.ariaCurrent = String(button.textContent === tab.name);

  const side = el("aside.side");
  const pane = el("div.pane");
  clear(view, ...(tab.sidebar ? [side, pane] : [pane]));
  pane.append(el("p.empty", {}, "loading…"));

  try {
    await tab.render(side, pane);
  } catch (err) {
    clear(pane, el("h3", {}, "That did not load"), el("pre", {}, (err as Error).message));
  }
}

clear(
  nav,
  ...tabs.map((tab) => el("button", { onclick: () => void show(tab) }, tab.name)),
);

async function heartbeat() {
  try {
    const status = await json<Status>("/health");
    summary.textContent = `${status.host.hostname} · ${status.version} · ${Math.round(status.uptime / 60)}m`;
  } catch {
    summary.textContent = "daemon unreachable";
  }
}

await show(current);
await heartbeat();
setInterval(() => void heartbeat(), 10000);
