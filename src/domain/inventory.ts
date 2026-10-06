import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../core/config.ts";
import type { SessionKind } from "./session.ts";

/**
 * What the sessions reported at their start, held for the daemon's life and on disk across
 * restarts: the newest sighting per session kind. It lives on its own because both the views
 * (`context.ts`) and the capability matching (`capabilities.ts`) read it, and those two must not
 * depend on each other — configuration here is frozen at import, so an import cycle in this layer
 * is a startup-order bug waiting for a different entry point.
 */

/** What Claude Code reported at a session's start: the tools it has, the MCP servers and how they came up. */
export interface Inventory {
  readonly tools: readonly string[];
  readonly mcpServers: readonly { name: string; status: string; tools?: readonly { name: string; description?: string }[] }[];
  readonly skills: readonly string[];
  readonly slashCommands: readonly string[];
  readonly agents: readonly string[];
  readonly model: string;
  readonly at: string;
}

// Kept next to the database, so a daemon that just restarted still knows what its last sessions had.
const inventoryPath = join(dirname(config.dbPath), "inventory.json");

const inventories: Partial<Record<SessionKind, Inventory>> = (() => {
  try {
    return JSON.parse(readFileSync(inventoryPath, "utf8")) as Partial<Record<SessionKind, Inventory>>;
  } catch {
    return {};
  }
})();

/** The session that just initialised tells what it was given; the newest per kind is what the views show. */
export function noteInit(kind: SessionKind, inventory: Inventory) {
  inventories[kind] = inventory;
  try {
    mkdirSync(dirname(inventoryPath), { recursive: true });
    writeFileSync(inventoryPath, JSON.stringify(inventories, null, 2));
  } catch {
    // A read-only data directory only costs the memory across restarts.
  }
}

/** Every kind that has reported, with what it reported. */
export const seen = (): [kind: SessionKind, inventory: Inventory][] => Object.entries(inventories) as [SessionKind, Inventory][];

/** Every MCP server a session has come up with lately, connectors included: what an agent's tools list picks from. */
export function knownServers(): string[] {
  const names = new Set<string>();
  for (const [, inv] of seen()) for (const s of inv.mcpServers) names.add(s.name);
  return [...names];
}

/** Every MCP server with how it came up and what it offers; the newest sighting of each one wins. */
export function serverStates(): { name: string; status: string; tools: readonly string[] }[] {
  const out = new Map<string, { name: string; status: string; tools: readonly string[] }>();
  for (const [, inv] of seen()) for (const s of inv.mcpServers) out.set(s.name, { name: s.name, status: s.status, tools: (s.tools ?? []).map((t) => t.name) });
  return [...out.values()];
}
