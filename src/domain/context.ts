import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "../core/config.ts";
import { prompts as connectorPrompts, serverConnectors } from "../connectors/loader.ts";
import type { SessionKind } from "./session.ts";
import { unavailable, type Unavailable } from "./capabilities.ts";
import { seen as seenInventories, type Inventory } from "./inventory.ts";
import { kv } from "../core/db.ts";
import { resetSection, saveSection, sections } from "./prompts.ts";
import { claudeSync, directServers, isRequired, noteTools, seenTools, serverOn, skillOn, syncedConnectors, toolOn, toolPrefix } from "./tool-registry.ts";

/**
 * What pai's sessions are given, in one list that can be read and edited: instructions, memories, skills and tools,
 * each named uniquely, since a name is how `save` finds it. Clients decode `surfaces` as required, so it stays, always
 * chat. An item that comes from a connector says which, so a client can leave it to that connector's page.
 */

const CHAT = ["chat"] as const;

export interface ContextItem {
  readonly kind: "instruction" | "memory" | "skill" | "tool";
  readonly name: string;
  readonly description: string;
  /** Where it comes from: a file path that can be edited, or the source in code. */
  readonly source: string;
  readonly editable: boolean;
  readonly surfaces: typeof CHAT;
  /** The connector it comes from. */
  readonly connector?: string;
  /** What it is for and who gets it, in the user's words. */
  readonly what?: string;
  readonly goesTo?: string;
  /** A built-in section the user has rewritten; `fallback` is what Reset goes back to. */
  readonly overridden?: boolean;
  readonly fallback?: string;
  readonly id?: string;
  /** A skill: whether sessions get it. */
  readonly on?: boolean;
  readonly body?: string;
  /** For a tool server: each tool with what it does. */
  readonly tools?: readonly { name: string; description?: string }[];
}

const readIf = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : undefined);

/** What Claude Code's own tools do, in a line each; the init names them but says nothing more. */
const BUILTIN: Record<string, string> = {
  Bash: "Runs a shell command",
  Read: "Reads a file (text, images, PDFs, notebooks)",
  Edit: "Replaces an exact string in a file",
  Write: "Writes a whole file",
  Glob: "Finds files by pattern",
  Grep: "Searches file contents",
  WebFetch: "Fetches a web page",
  WebSearch: "Searches the web",
  Agent: "Runs a subagent on a task",
  Task: "Runs a subagent on a task",
  AskUserQuestion: "Asks the user to choose",
  TodoWrite: "Keeps a task list for the turn",
  NotebookEdit: "Edits a notebook cell",
  Skill: "Loads a skill",
  ToolSearch: "Loads a deferred tool",
  Monitor: "Watches a stream in the background",
  KillShell: "Stops a background shell",
  BashOutput: "Reads a background shell's output",
  TaskStop: "Stops a background task",
  TaskOutput: "Reads a background task's output",
  ExitPlanMode: "Ends plan mode",
  EnterPlanMode: "Starts plan mode",
  ListMcpResourcesTool: "Lists MCP resources",
  ReadMcpResourceTool: "Reads an MCP resource",
  SendMessage: "Messages another agent",
  ListAgents: "Lists agents",
  ScheduleWakeup: "Schedules a wake-up",
  CronCreate: "Schedules a recurring prompt",
  CronList: "Lists schedules",
  CronDelete: "Removes a schedule",
  Workflow: "Runs a multi-agent workflow",
  LSP: "Language server queries",
};

/** `mcp__<server>__<tool>` → server and tool; a built-in has no server. */
const split = (name: string) => {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? { server: m[1]!, tool: m[2]! } : { server: "", tool: name };
};

const connectorDir = (name: string) => `modules/connectors/${name}`;

const fileItem = (kind: "instruction" | "memory", name: string, description: string, source: string): ContextItem => ({ kind, name, description, source, editable: true, surfaces: CHAT, body: readIf(source) ?? "" });

function instructions(): ContextItem[] {
  return [
    { ...fileItem("instruction", "Persona", "How pai behaves", join(config.workspace, "CLAUDE.md")), what: "Your own description of pai, in workspace/CLAUDE.md. Claude Code reads it by itself in every session whose working directory is the workspace, and its @MEMORY.md line is what pulls memory in.", goesTo: "General and threads" },
    ...sections().map((s): ContextItem => ({ kind: "instruction", id: s.id, name: s.title, description: s.what, what: s.what, goesTo: s.goesTo, source: s.source, editable: true, overridden: s.overridden, fallback: s.fallback, surfaces: CHAT, body: s.text })),
    ...connectorPrompts().map((p): ContextItem => ({ kind: "instruction", name: p.title, description: `From ${p.title}`, what: `Written by the ${p.title} connector, sent while it is running.`, goesTo: "Every session", source: connectorDir(p.connector), editable: false, surfaces: CHAT, connector: p.connector, body: p.text })),
  ];
}

const frontmatterDescription = (raw: string) => /^description:\s*(.+)$/m.exec(raw)?.[1] ?? "";

/** Claude Code's own memory for the workspace: `~/.claude/projects/<cwd as a slug>/memory/`. */
function autoMemories(): ContextItem[] {
  const dir = join(homedir(), ".claude", "projects", config.workspace.replace(/[/.]/g, "-"), "memory");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort((a, b) => (a === "MEMORY.md" ? -1 : b === "MEMORY.md" ? 1 : a.localeCompare(b)))
    .map((name) => {
      const file = join(dir, name);
      return fileItem("memory", `memory/${name}`, frontmatterDescription(readIf(file) ?? "") || (name === "MEMORY.md" ? "Memory index" : ""), file);
    });
}

const MEMORY_WHAT = "What pai remembers about you. It is one file, workspace/MEMORY.md: the @MEMORY.md line in Persona loads it into General and threads at the start of each session. Sessions change it with the edit_memory tool, and you can edit it here. Workers cannot: they report lasting facts to General.";
const memories = (): ContextItem[] => [
  { ...fileItem("memory", "Memory", "What pai remembers", join(config.workspace, "MEMORY.md")), what: MEMORY_WHAT, goesTo: "General and threads" },
  ...autoMemories().map((m) => ({ ...m, what: "Left over from Claude Code's own memory, which sessions no longer load or write. Move what matters into Memory.", goesTo: "No session" })),
];

function skillsIn(dir: string): ContextItem[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isDirectory() && existsSync(join(dir, name, "SKILL.md")))
    .map((name) => {
      const source = join(dir, name, "SKILL.md");
      const body = readIf(source) ?? "";
      return { kind: "skill" as const, name, description: frontmatterDescription(body), source, editable: true, on: skillOn(name), surfaces: CHAT, body };
    });
}

const skillsDir = () => join(config.workspace, ".claude", "skills");

const skills = (): ContextItem[] => skillsIn(skillsDir());

/** For a server that cannot answer: why, and the live one that covers the same capability. */
function deadNote(server: string, dead: ReadonlyMap<string, Unavailable>) {
  const u = dead.get(server);
  if (!u) return "";
  return ` · ${u.reason === "off" ? "off for every session" : u.reason === "failed" ? "failed to start" : "not signed in"}${u.instead ? `, use ${u.instead.server} (the ${u.instead.capability} capability)` : ""}`;
}

const BUILT_IN_SOURCE = "claude code";

const serverSource = (server: string, connectors: ReadonlyMap<string, string>) => {
  const connector = connectors.get(server);
  return connector ? connectorDir(connector) : server.startsWith("claude.ai ") ? "claude.ai connector" : "mcp server";
};

/** What a running session actually has, server by server, from the newest init of each kind; nothing before the first one. */
function tools(): ContextItem[] {
  const connectors = serverConnectors();
  const out: ContextItem[] = [];
  const dead = new Map(unavailable().map((u) => [u.server, u]));
  const inventories = Object.fromEntries(seenInventories()) as Partial<Record<SessionKind, Inventory>>;
  const kinds = Object.keys(inventories) as SessionKind[];
  const byServer = new Map<string, Set<string>>();
  for (const kind of kinds)
    for (const name of inventories[kind]!.tools) {
      const { server, tool } = split(name);
      byServer.set(server, (byServer.get(server) ?? new Set<string>()).add(tool));
    }
  // Tool names carry the server with dots and spaces turned into underscores ("claude.ai Balance"
  // → "claude_ai_Balance"); the status list has the name as configured.
  const key = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, "_");
  const status = new Map<string, Inventory["mcpServers"][number]>();
  for (const kind of kinds) for (const s of inventories[kind]!.mcpServers) status.set(key(s.name), s);
  for (const [server, found] of byServer) {
    const names = [...found].sort();
    const described = new Map((status.get(server)?.tools ?? []).map((t) => [t.name, t.description]));
    const tools = names.map((name) => ({ name, description: server ? described.get(name) : BUILTIN[name] }));
    out.push({
      kind: "tool",
      name: server ? (status.get(server)?.name ?? server) : "Claude Code built-ins",
      description: server ? `${status.get(server)?.status ?? "connected"} · ${names.length} tools${deadNote(status.get(server)?.name ?? server, dead)}` : `${names.length} tools`,
      source: server ? serverSource(status.get(server)?.name ?? server, connectors) : BUILT_IN_SOURCE,
      editable: false,
      surfaces: CHAT,
      connector: connectors.get(status.get(server)?.name ?? server),
      body: names.join("\n"),
      tools,
    });
  }
  // A server that came up without tools (failed, needs auth) still deserves a line.
  for (const [server, s] of status)
    if (!byServer.has(server)) out.push({ kind: "tool", name: s.name, description: `${s.status} · no tools${deadNote(s.name, dead)}`, source: serverSource(s.name, connectors), editable: false, surfaces: CHAT, connector: connectors.get(s.name) });
  return out.sort((a, b) => (a.source === BUILT_IN_SOURCE ? -1 : b.source === BUILT_IN_SOURCE ? 1 : a.name.localeCompare(b.name)));
}

/** Writes an editable item; the name is how the context lists it. A built-in section's text goes to its override. */
export function save(name: string, text: string) {
  const item = context().items.find((x) => x.name === name && x.editable);
  if (!item) throw new Error(`no editable item named ${JSON.stringify(name)}`);
  if (item.id) saveSection(item.id, text);
  else writeFileSync(item.source, text);
  return { ...item, body: text };
}

/** A built-in section back to its default. */
export function reset(name: string) {
  const item = context().items.find((x) => x.name === name && x.id);
  if (!item?.id) throw new Error(`no section named ${JSON.stringify(name)}`);
  resetSection(item.id);
}

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function createSkill(name: string, description: string) {
  if (!SKILL_NAME.test(name)) throw new Error("A skill's name is lowercase letters, digits and dashes");
  const dir = join(skillsDir(), name);
  if (existsSync(dir)) throw new Error(`A skill named ${name} exists`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description.replace(/\s+/g, " ").trim()}\n---\n\n`);
}

export function deleteSkill(name: string) {
  if (!SKILL_NAME.test(name) || !existsSync(join(skillsDir(), name, "SKILL.md"))) throw new Error(`no skill named ${JSON.stringify(name)}`);
  rmSync(join(skillsDir(), name), { recursive: true });
}

const MOVED = "user-context-moved";

/**
 * Sessions no longer read the user's settings, so what used to arrive from ~/.claude comes into the workspace once:
 * the skills, and the global instructions as the "Your own rules" section.
 */
export function moveUserContext() {
  if (kv.get(MOVED)) return;
  const dir = join(homedir(), ".claude", "skills");
  if (existsSync(dir))
    for (const name of readdirSync(dir)) {
      const target = join(skillsDir(), name);
      if (existsSync(join(dir, name, "SKILL.md")) && !existsSync(target)) cpSync(join(dir, name), target, { recursive: true, dereference: true });
    }
  const global = readIf(join(homedir(), ".claude", "CLAUDE.md"));
  if (global?.trim()) saveSection("global", global);
  kv.set(MOVED, "1");
}

export type ProviderSource = "builtin" | "pai" | "connector" | "direct" | "claude.ai";

export interface Provider {
  readonly name: string;
  readonly source: ProviderSource;
  readonly what: string;
  /** Where it comes from, as a sentence. */
  readonly origin: string;
  readonly on: boolean;
  readonly required: boolean;
  /** How it came up, and why not when it did not. */
  readonly status: string;
  readonly healthy: boolean;
  readonly connector?: string;
  readonly tools: readonly { name: string; full: string; description?: string; on: boolean }[];
  /** A synced connector: the address and sign-in to take it over directly. */
  readonly move?: { url: string; name: string; auth: "bearer" | "oauth" };
  readonly direct?: { url: string; auth: string; replaces?: string };
}

const WHAT: Readonly<Record<string, string>> = {
  pai: "pai's own tools: reaching the user, tasks, workers, routines, recall, memory. Sessions cannot work without it.",
  playwright: "A browser on the box, for sites with no API. pai runs one server, every session connects to it.",
  keep: "Keep, as pai's account: projects, tasks and docs in every workspace pai is a member of. One server covers them all.",
  dev: "dev, on the same box: repositories, files, diffs and Claude Code sessions.",
  "claude.ai Balance": "Your calendar and week: events, spheres, timers.",
  "claude.ai Notion": "Notion pages, databases and calendar.",
  "claude.ai Gmail": "Gmail through the account. pai's own mail connector is separate.",
  "claude.ai Google Drive": "Google Drive files.",
  "claude.ai Google Sheets": "Google Sheets.",
  "claude.ai Google Calendar": "Google Calendar. The calendar here is Balance, so this stays off.",
  "claude.ai Kenoverse": "Kenoverse: saving things to learn as spaced-repetition concepts.",
  "claude.ai Claude Docs": "Living docs on claude.ai.",
};

/** A connector's address when moved may differ from what the account has on record, and some sign in with a token. */
const MOVE: Readonly<Record<string, { url?: string; auth: "bearer" | "oauth" }>> = {
  "claude.ai Balance": { url: "https://balance.desk.atmagaming.com/mcp", auth: "bearer" },
};

const BUILT_IN_NAME = "Claude Code built-ins";

const statusLine = (status: string | undefined, on: boolean) => {
  if (!on) return "Off";
  if (!status) return "Starts with the next session";
  if (status === "connected") return "Connected";
  if (status === "needs-auth") return "Needs sign-in";
  if (status === "failed") return "Failed to start";
  return status;
};

/** Every server sessions could have, switched off ones included, which the inventory alone cannot say: it only knows what came up. */
export function providers(): { claudeSync: boolean; providers: Provider[] } {
  const inventories = seenInventories().map(([, inv]) => inv);
  const status = new Map<string, Inventory["mcpServers"][number]>();
  for (const inv of inventories) for (const s of inv.mcpServers) status.set(s.name, s);
  for (const [name, s] of status) if (s.tools?.length) noteTools(name, s.tools);
  const seen = seenTools();
  const connectors = serverConnectors();
  const toolsOf = (server: string, listed?: readonly { name: string; description?: string }[]) =>
    (listed?.length ? listed : (seen[server] ?? [])).map((t) => {
      const full = `${toolPrefix(server)}__${t.name}`;
      return { name: t.name, full, description: t.description, on: toolOn(full) };
    });
  const row = (name: string, source: ProviderSource, what: string, origin: string, extra: Partial<Provider> = {}, listed?: readonly { name: string; description?: string }[]): Provider => {
    const on = serverOn(name);
    const reported = status.get(name)?.status;
    return { name, source, what, origin, on, required: isRequired(name), status: statusLine(reported, on), healthy: on && (!reported || reported === "connected"), tools: toolsOf(name, listed), ...extra };
  };
  const builtIns = [...new Set(inventories.flatMap((inv) => inv.tools.filter((t) => !t.startsWith("mcp__"))))].sort();
  const out: Provider[] = [
    {
      name: BUILT_IN_NAME,
      source: "builtin",
      what: "What Claude Code itself can do: read and edit files, run commands, search the web.",
      origin: "Part of Claude Code. These are not an MCP server; each can be switched off below.",
      on: true,
      required: true,
      status: "Always on",
      healthy: true,
      tools: builtIns.map((t) => ({ name: t, full: t, description: BUILTIN[t], on: toolOn(t) })),
    },
    row("pai", "pai", WHAT.pai!, "Built into pai, one instance per session."),
    row("playwright", "pai", WHAT.playwright!, "An MCP server pai runs on the box."),
    ...(config.keepKey ? [row("keep", "pai", WHAT.keep!, "An MCP server over HTTP, with pai's Keep key.")] : []),
    ...(config.dev.token ? [row("dev", "pai", WHAT.dev!, "An MCP server over HTTP, on the same box.")] : []),
    ...[...connectors].map(([server, connector]) => row(server, "connector", `The tools of the ${connector} connector.`, `The ${connector} connector, in elumixor/desk-connectors. Its accounts and settings are on its own page.`, { connector })),
    ...directServers().map((d) => row(d.name, "direct", WHAT[d.replaces ?? ""] ?? "An MCP server you added.", `An MCP server pai connects to directly at ${d.url}.`, { direct: { url: d.url, auth: d.auth, ...(d.replaces ? { replaces: d.replaces } : {}) } })),
    ...(claudeSync() ? syncedConnectors() : []).map((c) => {
      const known = MOVE[c.name];
      const moved = directServers().some((d) => d.replaces === c.name);
      return row(c.name, "claude.ai", WHAT[c.name] ?? "A connector on your claude.ai account.", "Synced from your claude.ai account, through Anthropic's proxy.", moved ? {} : { move: { url: known?.url ?? c.url, name: c.name.replace(/^claude\.ai /, "").toLowerCase().replace(/\s+/g, "-"), auth: known?.auth ?? "oauth" } }, c.tools);
    }),
  ];
  return { claudeSync: claudeSync(), providers: out };
}

export function context() {
  const seen = seenInventories().map(([kind, inv]) => ({ kind, model: inv.model, at: inv.at, skills: inv.skills, agents: inv.agents }));
  return { surfaces: CHAT, items: [...instructions(), ...memories(), ...skills(), ...tools()], sessions: seen };
}
