import { syncReports } from "./api.ts";
import { el } from "./dom.ts";
import { icon, type IconName } from "./icons.ts";
import { current, linkTo, onRoute, type RouteName } from "./router.ts";
import type { SyncReport } from "./types.ts";

/**
 * The four icons in the corner: the chat, the board, the editor, and settings (which also
 * holds the modules, the routines, the projects, the context and the agents). The settings
 * icon carries how many things wait on the user. After them, a dot for whether the Macs'
 * files have reached the box.
 */

const ITEMS: readonly { name: RouteName; title: string; icon: IconName; active: (name: RouteName) => boolean }[] = [
  { name: "home", title: "Chat (⌘1)", icon: "message", active: (n) => n === "home" || n === "chat" },
  { name: "board", title: "Board (⌘2)", icon: "board", active: (n) => n === "board" },
  { name: "editor", title: "Editor (⌘3)", icon: "file", active: (n) => n === "editor" },
  { name: "settings", title: "Settings (⌘,)", icon: "settings", active: (n) => ["settings", "agents", "modules", "automations", "projects", "context"].includes(n) },
];

export function nav(root: HTMLElement) {
  const links = ITEMS.map((item) => linkTo(item.name, el("a.nav-item", { title: item.title }, icon(item.icon, 15)) as HTMLAnchorElement));
  root.replaceChildren(...links, syncDot());
  const draw = () => {
    const route = current();
    ITEMS.forEach((item, i) => links[i]!.classList.toggle("on", item.active(route.name)));
  };
  draw();
  onRoute(draw);
}

/** A Mac that has not reported for this long is asleep or off: what it last said may be old. */
const STALE_MS = 3 * 60 * 1000;
/** Worst first: the dot takes the colour of the Mac that needs looking at most. */
const RANK = ["conflicts", "stale", "connecting", "paused", "off", "syncing", "synced"] as const;
type Shown = (typeof RANK)[number];

const ago = (at: string) => {
  const s = Math.round((Date.now() - Date.parse(at)) / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};

/**
 * Whether what is on this Mac (and any other) is on the box: green in sync, amber on its way,
 * red conflicts, grey paused, off, or not heard from. Hidden until a Mac's menu bar app reports.
 */
function syncDot() {
  const dot = el("span.nav-sync");
  dot.hidden = true;
  const draw = (reports: readonly SyncReport[]) => {
    dot.hidden = reports.length === 0;
    const shown = reports.map((r): { r: SyncReport; state: Shown } => ({ r, state: Date.now() - Date.parse(r.at) > STALE_MS ? "stale" : r.state }));
    const worst = shown.reduce<Shown>((w, x) => (RANK.indexOf(x.state) < RANK.indexOf(w) ? x.state : w), "synced");
    dot.dataset.state = worst;
    dot.title = ["Files on the box", ...shown.map(({ r, state }) => `${r.machine}: ${state === "stale" ? `not heard from since ${ago(r.at)} (${r.text})` : `${r.text} · ${ago(r.at)}`}`)].join("\n");
  };
  const refresh = () => syncReports().then(draw, () => {});
  void refresh();
  setInterval(() => void refresh(), 20_000);
  return dot;
}
