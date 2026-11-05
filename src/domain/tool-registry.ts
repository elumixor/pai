import { kv } from "../core/db.ts";
import { config } from "../core/config.ts";

/**
 * What sessions may have: the one place that decides. Sessions run with `strictMcpConfig` and without the user's
 * settings, so a server reaches one only through `sessionServers()` here or pai's own list in `session.ts`. The
 * account's claude.ai connectors are found by a probe (`claude-connectors.ts`) and passed explicitly, which is what
 * lets each be switched off on its own. Read inside `build()`, so a change needs no restart.
 */

export interface Described {
  readonly name: string;
  readonly description?: string;
}

/** An MCP server pai reaches itself rather than through the account. */
export interface DirectServer {
  readonly name: string;
  readonly url: string;
  readonly auth: "none" | "bearer" | "oauth";
  readonly token?: string;
  /** The synced connector it took over from, which "back to sync" switches on again. */
  readonly replaces?: string;
}

export interface SyncedConnector {
  readonly name: string;
  readonly id: string;
  readonly url: string;
  readonly status: string;
  readonly tools: readonly Described[];
}

interface State {
  claudeSync: boolean;
  offServers: string[];
  /** `mcp__<server>__<tool>`, or a built-in's own name. */
  offTools: string[];
  offSkills: string[];
  direct: DirectServer[];
  connectors: SyncedConnector[];
  /** The tools each server last offered, so a server that is switched off can still show them. */
  seenTools: Record<string, readonly Described[]>;
}

const KEY = "tool-registry";
/** The calendar lives in Balance; Google's connector never signed in on the box. */
const INITIAL: State = { claudeSync: true, offServers: ["claude.ai Google Calendar"], offTools: [], offSkills: [], direct: [], connectors: [], seenTools: {} };

let cached: State | undefined;

function state(): State {
  if (!cached) {
    const saved = kv.get(KEY);
    cached = { ...INITIAL, ...(saved ? (JSON.parse(saved) as Partial<State>) : {}) };
  }
  return cached;
}

function change(edit: (s: State) => void) {
  const s = state();
  edit(s);
  kv.set(KEY, JSON.stringify(s));
}

/** The prefix Claude Code gives a server's tools. */
export const toolPrefix = (server: string) => `mcp__${server.replace(/[^A-Za-z0-9_-]/g, "_")}`;

/** pai's own tools are how a session reports at all. */
export const isRequired = (server: string) => server === "pai";

export const claudeSync = () => state().claudeSync;
export const serverOn = (name: string) => isRequired(name) || !state().offServers.includes(name);
export const offTools = (): readonly string[] => state().offTools;
export const toolOn = (full: string) => !state().offTools.includes(full);
export const skillOn = (name: string) => !state().offSkills.includes(name);
export const skillOverrides = () => Object.fromEntries(state().offSkills.map((name) => [name, "off" as const]));
export const directServers = (): readonly DirectServer[] => state().direct;
export const directServer = (name: string) => state().direct.find((s) => s.name === name);
export const syncedConnectors = (): readonly SyncedConnector[] => state().connectors;
export const seenTools = () => state().seenTools;

export const setClaudeSync = (on: boolean) => change((s) => void (s.claudeSync = on));

const toggled = (list: readonly string[], name: string, on: boolean) => (on ? list.filter((x) => x !== name) : [...new Set([...list, name])]);
export const setServer = (name: string, on: boolean) => change((s) => void (s.offServers = toggled(s.offServers, name, on)));
export const setTool = (full: string, on: boolean) => change((s) => void (s.offTools = toggled(s.offTools, full, on)));
export const setSkill = (name: string, on: boolean) => change((s) => void (s.offSkills = toggled(s.offSkills, name, on)));

export const setConnectors = (connectors: readonly SyncedConnector[]) => change((s) => void (s.connectors = [...connectors]));

export const putDirect = (server: DirectServer) => change((s) => void (s.direct = [...s.direct.filter((d) => d.name !== server.name), server]));
export const dropDirect = (name: string) => change((s) => void (s.direct = s.direct.filter((d) => d.name !== name)));

export function noteTools(server: string, tools: readonly Described[]) {
  if (!tools.length) return;
  const known = state().seenTools[server];
  if (known && JSON.stringify(known) === JSON.stringify(tools)) return;
  change((s) => void (s.seenTools[server] = tools));
}

/** A direct OAuth server goes through the daemon, which holds the token and refreshes it (`direct-mcp.ts`): a session's headers are fixed when it starts. */
function directConfig(server: DirectServer) {
  if (server.auth === "oauth") return { type: "http" as const, url: `http://${config.host}:${config.port}/direct-mcp/${encodeURIComponent(server.name)}`, headers: config.token ? { authorization: `Bearer ${config.token}` } : {} };
  return { type: "http" as const, url: server.url, headers: server.token ? { authorization: `Bearer ${server.token}` } : {} };
}

/** The servers beyond pai's own that a session gets. Not yet filtered by what is off: callers filter, the view needs them all. */
export function sessionServers() {
  const out: Record<string, unknown> = {};
  if (state().claudeSync) for (const c of state().connectors) out[c.name] = { type: "claudeai-proxy", url: c.url, id: c.id };
  for (const d of state().direct) out[d.name] = directConfig(d);
  return out;
}
