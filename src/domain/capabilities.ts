import { config } from "../core/config.ts";
import { knownServers } from "./context.ts";

/**
 * An agent's tools list names capabilities — `gmail`, `browser`, `calendar` — while a session
 * has MCP servers: `playwright`, `claude.ai Balance`. A capability is matched as a substring of
 * a server name, so one whose word appears in no server name silently resolves to nothing. This
 * is where the two meet: the aliases that bridge the names, and the check that says when a
 * declared capability will not arrive.
 */

/** Capabilities whose server is named something else; the name in the docs and in a brief has to work. */
const ALIASES: Readonly<Record<string, readonly string[]>> = {
  // One Playwright MCP server per daemon (browser.ts), registered as `playwright`.
  browser: ["playwright"],
  // The calendar here is Balance, not Google's (which is in `deniedConnectors`).
  calendar: ["balance"],
};

/** Every substring a capability may match: its own word plus the servers it is an alias for. */
export const matchTerms = (capability: string): readonly string[] => {
  const c = capability.toLowerCase();
  return [c, ...(ALIASES[c] ?? [])];
};

const matches = (server: string, capability: string) => matchTerms(capability).some((term) => server.toLowerCase().includes(term));

/** An MCP server an agent may use: `pai` always; anything else only when its tools list names it. */
export function serverAllowed(server: string, allowed: readonly string[] | undefined) {
  if (!allowed || server === "pai") return true;
  return allowed.some((a) => a === "*" || matches(server, a));
}

/** A sub-agent gets at most its parent's tools: the capabilities of `wanted` its parent also covers. */
export function narrowed(wanted: readonly string[], parent: readonly string[]): string[] {
  return wanted.filter((w) => parent.some((p) => p === "*" || matchTerms(w).some((term) => matches(term, p))));
}

/**
 * Declared capabilities that match no MCP server any session has come up with: tools an agent was
 * promised and will not get. Empty before the first session has reported its inventory, since
 * there is nothing to check against then.
 */
export function unresolved(tools: readonly string[] | null | undefined): string[] {
  if (!tools?.length) return [];
  const servers = knownServers().filter((name) => !config.deniedConnectors.includes(name) && name !== "pai");
  if (!servers.length) return [];
  return tools.filter((t) => t !== "*" && !servers.some((s) => matches(s, t)));
}
