import { baseUrl, modules as listModules, status, usage } from "./api.ts";
import { clear, el } from "./dom.ts";
import { icon, logo, type IconName } from "./icons.ts";
import { usageStats } from "./rings.ts";
import { current, linkTo, navigate, onRoute, type RouteName } from "./router.ts";
import type { ModuleInfo } from "./types.ts";

/**
 * The bar across the top of every view: where you are (the chat, the board, the editor), the
 * rest behind one menu (the modules' own pages, what the daemon is made of, settings), the
 * quota rings, and the bell with what waits on you.
 */

const TABS: readonly { name: RouteName; label: string; icon: IconName; active: (name: RouteName) => boolean }[] = [
  { name: "home", label: "Chat", icon: "message", active: (n) => n === "home" || n === "chat" },
  { name: "board", label: "Board", icon: "board", active: (n) => n === "board" },
  { name: "editor", label: "Editor", icon: "code", active: (n) => n === "editor" },
];

const PAGES: readonly { name: RouteName; label: string; icon: IconName; hint: string }[] = [
  { name: "agents", label: "Agents", icon: "users", hint: "every agent, its chat and tasks" },
  { name: "modules", label: "Modules", icon: "zap", hint: "what pai is made of, settings per module" },
  { name: "automations", label: "Routines", icon: "clock", hint: "what runs on its own" },
  { name: "projects", label: "Projects", icon: "folder", hint: "repositories and contexts" },
  { name: "context", label: "Context", icon: "book", hint: "instructions, memories, skills, tools" },
];

export function topNav(root: HTMLElement) {
  const tabs = el("div.nav-tabs");
  const menu = el("div.nav-menu", { hidden: true });
  const more = el("button.nav-tab.nav-more", { onclick: (e: Event) => (e.stopPropagation(), toggleMenu()) }, el("span", {}, "More"), icon("chevron", 12));
  const rings = el("div.nav-usage");
  const bell = el("span.nav-bell", { hidden: true });
  const bellButton = el("button.nav-round", { title: "what waits on you", onclick: () => window.dispatchEvent(new Event("pai:pile")) }, icon("bell", 15), bell);
  clear(
    root,
    linkTo("home", el("a.nav-brand", {}, logo(26), el("span", {}, "pai")) as HTMLAnchorElement),
    tabs,
    el("div.nav-right", {}, rings, bellButton, el("button.nav-round", { title: "settings", onclick: () => navigate("settings") }, icon("settings", 15))),
    menu,
  );

  const draw = () => {
    const route = current();
    clear(
      tabs,
      ...TABS.map((t) => linkTo(t.name, el("a.nav-tab", { class: `nav-tab${t.active(route.name) ? " on" : ""}` }, icon(t.icon, 14), el("span", {}, t.label)) as HTMLAnchorElement)),
      more,
    );
    more.classList.toggle("on", PAGES.some((p) => p.name === route.name));
  };
  draw();
  onRoute(draw);

  const toggleMenu = () => {
    menu.hidden = !menu.hidden;
    if (!menu.hidden) void fillMenu();
  };
  document.addEventListener("click", (event) => {
    if (!menu.hidden && !menu.contains(event.target as Node)) menu.hidden = true;
  });
  document.addEventListener("keydown", (event) => event.key === "Escape" && (menu.hidden = true));

  const item = (label: string, iconName: IconName, hint: string, link: HTMLAnchorElement | HTMLButtonElement) => {
    link.classList.add("menu-item");
    link.append(icon(iconName, 14), el("span.menu-text", {}, el("span", {}, label), el("span.dim", {}, hint)));
    link.addEventListener("click", () => (menu.hidden = true));
    return link;
  };

  async function fillMenu() {
    clear(menu, el("p.hint", {}, "…"));
    const [mods, health] = await Promise.all([listModules().catch(() => [] as ModuleInfo[]), status().catch(() => undefined)]);
    const withUi = mods.filter((m) => typeof m.ui === "string");
    const healthOf = (m: ModuleInfo) => {
      const h = m.status.health as { ok?: boolean; detail?: string } | string | undefined;
      return typeof h === "string" ? h : (h?.detail ?? (h?.ok === false ? "down" : "live"));
    };
    clear(
      menu,
      el("h4.menu-title", {}, "Modules"),
      ...withUi.map((m) => item(m.title, "zap", healthOf(m), el("a", { href: `${baseUrl()}${m.ui}`, target: "_blank", rel: "noreferrer" }) as HTMLAnchorElement)),
      health?.editor.url ? item("VS Code", "external", "code-server on the box", el("a", { href: health.editor.url, target: "_blank", rel: "noreferrer" }) as HTMLAnchorElement) : undefined,
      el("h4.menu-title", {}, "pai"),
      ...PAGES.map((p) => item(p.label, p.icon, p.hint, linkTo(p.name, el("a") as HTMLAnchorElement))),
    );
  }

  async function refreshUsage() {
    try {
      clear(rings, ...usageStats(await usage()).slice(1));
    } catch {
      clear(rings);
    }
  }
  void refreshUsage();
  setInterval(() => void refreshUsage(), 60_000);
  window.addEventListener("pai:prefs", () => void refreshUsage());
  window.addEventListener("pai:needs", (event) => {
    const n = (event as CustomEvent<number>).detail;
    bell.textContent = String(n);
    bell.hidden = !n;
  });
}
