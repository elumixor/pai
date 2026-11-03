import { config } from "../core/config.ts";
import { knownServers, serverStates } from "./inventory.ts";

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

/** A server a session is offered but cannot use, and what to reach for instead. */
export interface Unavailable {
  readonly server: string;
  /** `off`: the user switched it off for every session. `needs-auth`: it never signed in. */
  readonly reason: "off" | "needs-auth";
  /** The live server that answers the same capability, with a few of its tools — derived, never written down. */
  readonly instead?: { readonly server: string; readonly capability: string; readonly tools: readonly string[] };
}

const DEAD = new Set(["needs-auth", "failed"]);

/**
 * Servers a session sees in its tool list and will never get an answer from: the ones the user
 * denied (`deniedConnectors`) and the ones that came up unauthenticated. Each is paired, through
 * the alias table, with the live server that covers the same capability — so the sentence an agent
 * reads names the move to make instead of leaving it to improvise.
 */
export function unavailable(): Unavailable[] {
  const states = serverStates();
  const live = states.filter((s) => s.status === "connected" && !config.deniedConnectors.includes(s.name));
  const out: Unavailable[] = [];
  for (const s of states) {
    const reason = config.deniedConnectors.includes(s.name) ? "off" : DEAD.has(s.status) ? "needs-auth" : undefined;
    if (!reason) continue;
    const instead = replacement(s, live);
    out.push({ server: s.name, reason, ...(instead ? { instead } : {}) });
  }
  return out;
}

/**
 * The capability whose word names the dead server, and the live server its alias points at. The
 * tools named are the ones both offer — the same call under a different server, which is the move
 * an agent should make — falling back to whatever the live one starts with.
 */
function replacement(dead: Readonly<{ name: string; tools: readonly string[] }>, live: readonly { name: string; tools: readonly string[] }[]) {
  for (const [capability, targets] of Object.entries(ALIASES)) {
    if (!matches(dead.name, capability)) continue;
    for (const target of targets) {
      const server = live.find((s) => matches(s.name, target));
      if (!server) continue;
      const shared = server.tools.filter((t) => dead.tools.includes(t));
      return { server: server.name, capability, tools: (shared.length ? shared : server.tools).slice(0, 4) };
    }
  }
  return undefined;
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
