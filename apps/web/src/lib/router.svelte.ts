import { goto } from "$app/navigation";
import { page } from "$app/state";

/**
 * Where the client is, as an address in the hash (the daemon owns every real path): General at the root, an agent's
 * chat and a thread under their ids, a new thread (under the thread it is started from, when it is), and the settings
 * sheet over whatever was open — so a page can be linked to and the back button means something.
 */
export type RouteName = "home" | "chat" | "thread" | "new" | "settings";
const NAMES: readonly RouteName[] = ["home", "chat", "thread", "new", "settings"];
/** What needs its id: a bare `chat` or `thread` is the front page. */
const NEEDS_PARAM: readonly RouteName[] = ["chat", "thread"];

export interface Route {
  readonly name: RouteName;
  readonly param?: string;
}

export function parse(raw: string): Route {
  const [first = "", second] = raw.replace(/^[/#]+|\/+$/g, "").split("/");
  // The dashboard's pages became sections of the settings.
  if (["automations", "context", "spend", "connectors", "skills"].includes(first)) return { name: "settings", param: first === "skills" ? "context" : first };
  const name = first as RouteName;
  if (!NAMES.includes(name) || name === "home") return { name: "home" };
  if (NEEDS_PARAM.includes(name) && !second) return { name: "home" };
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
