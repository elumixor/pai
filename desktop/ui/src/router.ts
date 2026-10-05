import { inDesktop } from "./api.ts";

/**
 * Where the client is, as an address: the work view at the root, the dashboard's pages and
 * the editor each at a path of their own, so a page can be linked to and the back button
 * means something. Served by the daemon the path is under `/ui/`; the desktop app has no
 * server behind its window, so there the route lives in the hash.
 */
export type Route = "work" | "dashboard" | "agents" | "modules" | "automations" | "projects" | "context" | "editor" | "settings";
const ROUTES: readonly Route[] = ["work", "dashboard", "agents", "modules", "automations", "projects", "context", "editor", "settings"];

const underServer = location.protocol.startsWith("http") && location.pathname.startsWith("/ui") && !inDesktop;
const base = underServer ? location.pathname.replace(/^(\/ui).*/, "$1") : "";

const parse = (raw: string): Route => {
  const name = raw.replace(/^[/#]+|\/+$/g, "").split("/")[0] ?? "";
  return (ROUTES as readonly string[]).includes(name) && name !== "work" ? (name as Route) : "work";
};

export const current = (): Route => (underServer ? parse(location.pathname.slice(base.length)) : parse(location.hash));

export const href = (route: Route) => (underServer ? `${base}/${route === "work" ? "" : route}` : `#/${route === "work" ? "" : route}`);

const listeners = new Set<(route: Route) => void>();

export function navigate(route: Route, replace = false) {
  if (current() === route && !replace) return;
  const url = href(route);
  if (underServer) history[replace ? "replaceState" : "pushState"]({ route }, "", url);
  else if (location.hash !== url) location.hash = url;
  for (const listener of listeners) listener(route);
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
export function linkTo(route: Route, anchor: HTMLAnchorElement) {
  anchor.href = href(route);
  anchor.addEventListener("click", (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    navigate(route);
  });
  return anchor;
}
