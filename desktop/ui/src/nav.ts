import { el } from "./dom.ts";
import { icon, type IconName } from "./icons.ts";
import { current, linkTo, onRoute, type RouteName } from "./router.ts";

/**
 * The four icons in the corner: the chat, the board, the editor, and settings (which also
 * holds the modules, the routines, the projects, the context and the agents). The settings
 * icon carries how many things wait on the user.
 */

const ITEMS: readonly { name: RouteName; title: string; icon: IconName; active: (name: RouteName) => boolean }[] = [
  { name: "home", title: "Chat (⌘1)", icon: "message", active: (n) => n === "home" || n === "chat" },
  { name: "board", title: "Board (⌘2)", icon: "board", active: (n) => n === "board" },
  { name: "editor", title: "Editor (⌘3)", icon: "file", active: (n) => n === "editor" },
  { name: "settings", title: "Settings (⌘,)", icon: "settings", active: (n) => ["settings", "agents", "modules", "automations", "projects", "context"].includes(n) },
];

export function nav(root: HTMLElement) {
  const links = ITEMS.map((item) => linkTo(item.name, el("a.nav-item", { title: item.title }, icon(item.icon, 15)) as HTMLAnchorElement));
  root.replaceChildren(...links);
  const draw = () => {
    const route = current();
    ITEMS.forEach((item, i) => links[i]!.classList.toggle("on", item.active(route.name)));
  };
  draw();
  onRoute(draw);
}
