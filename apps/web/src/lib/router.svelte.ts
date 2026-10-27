import { goto } from "$app/navigation";
import { page } from "$app/state";

/**
 * Where the client is, as an address in the hash (the daemon owns every real path): the main chat at the root, an
 * agent's chat, a task, a thread, a project and the board under their ids, the threads view, and the settings sheet
 * over whatever was open — so a page can be linked to and the back button means something.
 */
export type RouteName = "home" | "chat" | "board" | "task" | "thread" | "project" | "threads" | "settings";
const NAMES: readonly RouteName[] = ["home", "chat", "board", "task", "thread", "project", "threads", "settings"];
/** What needs its id: a bare `chat` or `task` is the front page. */
const NEEDS_PARAM: readonly RouteName[] = ["chat", "task", "thread", "project"];

export interface Route {
  readonly name: RouteName;
  readonly param?: string;
}

export function parse(raw: string): Route {
  const [first = "", second] = raw.replace(/^[/#]+|\/+$/g, "").split("/");
  // The editor's old address opens the threads, which is what is left of it here.
  if (first === "editor" || first === "work") return { name: "threads", param: second ? decodeURIComponent(second) : undefined };
  // The dashboard's pages became sections of the settings.
  if (["agents", "modules", "automations", "projects", "context", "spend", "connectors", "skills"].includes(first)) return { name: "settings", param: first === "skills" ? "context" : first };
  if (first === "tasks") return { name: "board" };
  const name = first as RouteName;
  if (!NAMES.includes(name) || name === "home") return { name: "home" };
  if (NEEDS_PARAM.includes(name) && !second) return { name: "home" };
  if (name === "task" && !Number(second)) return { name: "home" };
  return second ? { name, param: decodeURIComponent(second) } : { name };
}

const pathOf = (route: Route) => (route.name === "home" ? "" : route.param ? `${route.name}/${encodeURIComponent(route.param)}` : route.name);
export const href = (route: Route | RouteName) => `#/${pathOf(typeof route === "string" ? { name: route } : route)}`;

/** The route the address names now. */
export const current = (): Route => parse(page.params.path ?? "");

export function navigate(route: Route | RouteName, replace = false) {
  const next = typeof route === "string" ? { name: route } : route;
  const now = current();
  if (now.name === next.name && (now.param ?? "") === (next.param ?? "") && !replace) return;
  void goto(href(next), { replaceState: replace, keepFocus: true, noScroll: true });
}
