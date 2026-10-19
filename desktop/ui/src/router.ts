import { inDesktop } from "./api.ts";

/**
 * Where the client is, as an address: the main chat at the root, an agent's thread and the
 * board under a slug, the dashboard's pages, the editor and the settings each at a path of
 * their own, so a page can be linked to and the back button means something. Served by the
 * daemon the path is under `/ui/`; the desktop app has no server behind its window, so there
 * the route lives in the hash.
 */
export type RouteName = "home" | "chat" | "agents" | "board" | "dashboard" | "modules" | "automations" | "projects" | "context" | "editor" | "settings" | "task" | "thread" | "project";
const NAMES: readonly RouteName[] = ["home", "chat", "agents", "board", "dashboard", "modules", "automations", "projects", "context", "editor", "settings", "task", "thread", "project"];

export interface Route {
  readonly name: RouteName;
  /** `chat/<slug>` (an agent's page), `project/<slug>` (a repo's) and `board/<slug>` carry the slug, `task/<id>` the task, `thread/<session>` a plain thread, `editor/<session>` a thread to open in the editor. */
  readonly param?: string;
}

const underServer = location.protocol.startsWith("http") && location.pathname.startsWith("/ui") && !inDesktop;
const base = underServer ? location.pathname.replace(/^(\/ui).*/, "$1") : "";

const parse = (raw: string): Route => {
  const [first = "", second] = raw.replace(/^[/#]+|\/+$/g, "").split("/");
  // The work view used to be the root; its old address still opens it.
  if (first === "work") return { name: "editor" };
  if (!(NAMES as readonly string[]).includes(first) || first === "home" || ((first === "chat" || first === "thread" || first === "project") && !second) || (first === "task" && !Number(second))) return { name: "home" };
  return second ? { name: first as RouteName, param: decodeURIComponent(second) } : { name: first as RouteName };
};

export const current = (): Route => (underServer ? parse(location.pathname.slice(base.length)) : parse(location.hash));

const pathOf = (route: Route) => (route.name === "home" ? "" : route.param ? `${route.name}/${encodeURIComponent(route.param)}` : route.name);
export const href = (route: Route | RouteName) => {
  const r = typeof route === "string" ? { name: route } : route;
  return underServer ? `${base}/${pathOf(r)}` : `#/${pathOf(r)}`;
};

const same = (a: Route, b: Route) => a.name === b.name && (a.param ?? "") === (b.param ?? "");

const listeners = new Set<(route: Route) => void>();

export function navigate(route: Route | RouteName, replace = false) {
  const next = typeof route === "string" ? { name: route } : route;
  if (same(current(), next) && !replace) return;
  const url = href(next);
  if (underServer) history[replace ? "replaceState" : "pushState"]({ route: next }, "", url);
  else if (location.hash !== url) location.hash = url;
  for (const listener of listeners) listener(next);
}

export function onRoute(listener: (route: Route) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

window.addEventListener("popstate", () => {
  for (const listener of listeners) listener(current());
});
window.addEventListener("hashchange", () => {
  if (!underServer) for (const listener of listeners) listener(current());
});

/** An anchor that goes through the router when clicked plainly, and is a real link otherwise. */
export function linkTo(route: Route | RouteName, anchor: HTMLAnchorElement) {
  anchor.href = href(route);
  anchor.addEventListener("click", (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    navigate(route);
  });
  return anchor;
}
