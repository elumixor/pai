import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "../core/config.ts";
import { prompts as connectorPrompts, serverConnectors } from "../connectors/loader.ts";
import type { SessionKind } from "./session.ts";
import { unavailable, type Unavailable } from "./capabilities.ts";
import { seen as seenInventories, type Inventory } from "./inventory.ts";
import { sections } from "./prompts.ts";

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
  const global = join(homedir(), ".claude", "CLAUDE.md");
  return [
    fileItem("instruction", "Persona", "How pai behaves", join(config.workspace, "CLAUDE.md")),
    ...(existsSync(global) ? [fileItem("instruction", "Global", "Your own instructions", global)] : []),
    ...sections().map(([name, text]): ContextItem => ({ kind: "instruction", name, description: "Built in", source: "src/domain/prompts.ts", editable: false, surfaces: CHAT, body: text })),
    ...connectorPrompts().map((p): ContextItem => ({ kind: "instruction", name: p.title, description: `From ${p.title}`, source: connectorDir(p.connector), editable: false, surfaces: CHAT, connector: p.connector, body: p.text })),
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

const memories = (): ContextItem[] => [fileItem("memory", "Memory", "What pai remembers", join(config.workspace, "MEMORY.md")), ...autoMemories()];

function skillsIn(dir: string): ContextItem[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isDirectory() && existsSync(join(dir, name, "SKILL.md")))
    .map((name) => {
      const source = join(dir, name, "SKILL.md");
      const body = readIf(source) ?? "";
      return { kind: "skill" as const, name, description: frontmatterDescription(body), source, editable: true, surfaces: CHAT, body };
    });
}

/** The workspace's skills, then the user's; a workspace skill wins over one of the same name. */
function skills(): ContextItem[] {
  const own = skillsIn(join(config.workspace, ".claude", "skills"));
  const taken = new Set(own.map((s) => s.name));
  return [...own, ...skillsIn(join(homedir(), ".claude", "skills")).filter((s) => !taken.has(s.name))];
}

/** For a server that cannot answer: why, and the live one that covers the same capability. */
function deadNote(server: string, dead: ReadonlyMap<string, Unavailable>) {
  const u = dead.get(server);
  if (!u) return "";
  return ` · ${u.reason === "off" ? "off for every session" : "not signed in"}${u.instead ? `, use ${u.instead.server} (the ${u.instead.capability} capability)` : ""}`;
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

/** Writes an editable item's file; the name is how the context lists it. */
export function save(name: string, text: string) {
  const item = context().items.find((x) => x.name === name && x.editable);
  if (!item) throw new Error(`no editable item named ${JSON.stringify(name)}`);
  writeFileSync(item.source, text);
  return { ...item, body: text };
}

export function context() {
  const seen = seenInventories().map(([kind, inv]) => ({ kind, model: inv.model, at: inv.at, skills: inv.skills, agents: inv.agents }));
  return { surfaces: CHAT, items: [...instructions(), ...memories(), ...skills(), ...tools()], sessions: seen };
}
