import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { config } from "../core/config.ts";
import { allPrompts as externalPrompts } from "../modules/external.ts";
import { modules } from "../modules/index.ts";
import { all as allProjects } from "./catalog.ts";
import type { SessionKind } from "./session.ts";
import { moduleHeading, sections } from "./prompts.ts";

/**
 * What each kind of Claude session is given, laid out so it can be read and edited in one
 * place: instructions, memories, skills, tools — and for each, which surfaces see it. The
 * surfaces are pai's own sessions (main, task, code) and a `claude` started in a terminal,
 * which gets the project's files and the user's global config but none of pai's tools.
 */

export const SURFACES = ["chat", "code", "terminal"] as const;
export type Surface = (typeof SURFACES)[number];

export interface ContextItem {
  readonly kind: "instruction" | "memory" | "skill" | "tool";
  readonly name: string;
  readonly description: string;
  /** Where it comes from: a file path that can be edited, or the source in code. */
  readonly source: string;
  readonly editable: boolean;
  readonly surfaces: readonly Surface[];
  /** For a project-scoped item. */
  readonly project?: string;
  readonly body?: string;
  /** For a tool server: each tool with what it does. */
  readonly tools?: readonly { name: string; description?: string }[];
}

const readIf = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : undefined);

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

/** Every MCP server a session has come up with lately, connectors included: what an agent's tools list picks from. */
export function knownServers(): string[] {
  const names = new Set<string>();
  for (const inv of Object.values(inventories)) for (const s of inv?.mcpServers ?? []) names.add(s.name);
  return [...names];
}

/** `mcp__<server>__<tool>` → server and tool; a built-in has no server. */
const split = (name: string) => {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? { server: m[1]!, tool: m[2]! } : { server: "", tool: name };
};

function instructions(): ContextItem[] {
  const out: ContextItem[] = [];
  const persona = join(config.workspace, "CLAUDE.md");
  out.push({ kind: "instruction", name: "persona (workspace/CLAUDE.md)", description: "read by every pai session, as the cwd's CLAUDE.md", source: persona, editable: true, surfaces: ["chat"], body: readIf(persona) });
  for (const [name, text, kinds] of sections())
    out.push({ kind: "instruction", name, description: "appended to the system prompt by src/domain/prompts.ts", source: "src/domain/prompts.ts", editable: false, surfaces: kinds, body: text });
  for (const m of modules)
    if (m.prompt && m.enabled())
      out.push({ kind: "instruction", name: moduleHeading(m.title), description: `what the ${m.title} module adds, appended after the general instructions`, source: `src/modules/${m.name}.ts`, editable: false, surfaces: m.prompt.kinds, body: m.prompt.text });
  for (const p of externalPrompts())
    out.push({ kind: "instruction", name: moduleHeading(p.title), description: `what the ${p.title} module adds, appended after the general instructions`, source: `modules/${p.module}`, editable: false, surfaces: p.kinds, body: p.text });
  for (const project of allProjects()) {
    const file = join(project.path, "CLAUDE.md");
    if (existsSync(file))
      out.push({ kind: "instruction", name: `${project.slug}/CLAUDE.md`, description: project.kind === "context" ? "the project's voice and rules" : "the repo's own instructions", source: file, editable: true, surfaces: [project.kind === "context" ? "chat" : "code", "terminal"], project: project.slug, body: readIf(file) });
  }
  const global = join(homedir(), ".claude", "CLAUDE.md");
  if (existsSync(global)) out.push({ kind: "instruction", name: "~/.claude/CLAUDE.md", description: "the user's global instructions — terminal sessions only, pai loads project settings alone", source: global, editable: true, surfaces: ["terminal"], body: readIf(global) });
  return out;
}

/** Claude Code's own memory for a directory: `~/.claude/projects/<cwd as a slug>/memory/`. */
function autoMemories(cwd: string, surfaces: readonly Surface[], project?: string): ContextItem[] {
  const dir = join(homedir(), ".claude", "projects", cwd.replace(/[/.]/g, "-"), "memory");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort((a, b) => (a === "MEMORY.md" ? -1 : b === "MEMORY.md" ? 1 : a.localeCompare(b)))
    .map((name) => {
      const file = join(dir, name);
      const raw = readIf(file) ?? "";
      const description = /^description:\s*(.+)$/m.exec(raw)?.[1] ?? (name === "MEMORY.md" ? "the index Claude Code loads each session" : "");
      return { kind: "memory" as const, name: project ? `${project}: ${name}` : name, description, source: file, editable: true, surfaces, project, body: raw };
    });
}

function memories(): ContextItem[] {
  const file = join(config.workspace, "MEMORY.md");
  const out: ContextItem[] = [{ kind: "memory", name: "MEMORY.md", description: "what the assistant remembers, a markdown file it edits itself", source: file, editable: true, surfaces: ["chat", "code"], body: readIf(file) ?? "" }];
  out.push(...autoMemories(config.workspace, ["chat"]));
  for (const project of allProjects()) out.push(...autoMemories(project.path, [project.kind === "context" ? "chat" : "code", "terminal"], project.slug));
  return out;
}

function skillsIn(dir: string, surfaces: readonly Surface[], project?: string): ContextItem[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isDirectory() && existsSync(join(dir, name, "SKILL.md")))
    .map((name) => {
      const file = join(dir, name, "SKILL.md");
      const raw = readIf(file) ?? "";
      const description = /^description:\s*(.+)$/m.exec(raw)?.[1] ?? "";
      return { kind: "skill" as const, name, description, source: file, editable: true, surfaces, project, body: raw };
    });
}

function skills(): ContextItem[] {
  const out = skillsIn(join(config.workspace, ".claude", "skills"), ["chat"]);
  for (const project of allProjects()) out.push(...skillsIn(join(project.path, ".claude", "skills"), project.kind === "context" ? ["chat", "terminal"] : ["code", "terminal"], project.slug));
  out.push(...skillsIn(join(homedir(), ".claude", "skills"), ["terminal"]));
  return out;
}

/** What a running session actually has, server by server, from the newest init of each kind. */
function liveTools(): ContextItem[] {
  const out: ContextItem[] = [];
  const kinds = Object.keys(inventories) as SessionKind[];
  const byServer = new Map<string, { tools: Set<string>; kinds: Set<SessionKind> }>();
  for (const kind of kinds)
    for (const name of inventories[kind]!.tools) {
      const { server, tool } = split(name);
      const entry = byServer.get(server) ?? { tools: new Set(), kinds: new Set() };
      entry.tools.add(tool);
      entry.kinds.add(kind);
      byServer.set(server, entry);
    }
  // Tool names carry the server with dots and spaces turned into underscores ("claude.ai Balance"
  // → "claude_ai_Balance"); the status list has the name as configured.
  const key = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, "_");
  const status = new Map<string, Inventory["mcpServers"][number]>();
  for (const kind of kinds) for (const s of inventories[kind]!.mcpServers) status.set(key(s.name), s);
  for (const [server, entry] of byServer) {
    const names = [...entry.tools].sort();
    const described = new Map((status.get(server)?.tools ?? []).map((t) => [t.name, t.description]));
    const tools = names.map((name) => ({ name, description: server ? described.get(name) : BUILTIN[name] }));
    out.push({
      kind: "tool",
      name: server ? (status.get(server)?.name ?? server) : "Claude Code built-ins",
      description: server ? `MCP server, ${status.get(server)?.status ?? "connected"} · ${names.length} tools` : `${names.length} tools`,
      source: server.startsWith("claude.ai ") ? "claude.ai connector" : server ? (modules.some((m) => m.tools?.server === server) ? `src/modules/${server}.ts` : `modules/${server}`) : "claude code",
      editable: false,
      surfaces: [...entry.kinds],
      body: names.join("\n"),
      tools,
    });
  }
  // A server that came up without tools (failed, needs auth) still deserves a line.
  for (const [server, s] of status)
    if (!byServer.has(server)) out.push({ kind: "tool", name: s.name, description: `MCP server, ${s.status} · no tools`, source: s.name.startsWith("claude.ai ") ? "claude.ai connector" : `modules/${s.name}`, editable: false, surfaces: [] });
  return out.sort((a, b) => (a.source === "claude code" ? -1 : b.source === "claude code" ? 1 : a.name.localeCompare(b.name)));
}

function tools(): ContextItem[] {
  const live = liveTools();
  if (live.length) return live;
  const out: ContextItem[] = [];
  for (const m of modules) {
    if (!m.tools) continue;
    const on = m.enabled();
    out.push({
      kind: "tool",
      name: `${m.tools.server}: ${m.tools.names.join(", ")}`,
      description: `${m.title}${on ? "" : " (off)"} — ${m.description}`,
      source: `src/modules/${m.name}.ts`,
      editable: false,
      surfaces: on ? m.tools.kinds : [],
    });
  }
  out.push({ kind: "tool", name: "claude.ai connectors (Gmail, Calendar, Drive, Notion, …)", description: "whatever is connected in the Claude account on the box", source: "claude.ai", editable: false, surfaces: ["chat", "code", "terminal"] });
  out.push({ kind: "tool", name: "Claude Code built-ins (Bash, Read, Edit, WebSearch, …)", description: "the standard tool set", source: "claude code", editable: false, surfaces: ["chat", "code", "terminal"] });
  return out;
}

/** Writes an editable item's file; the name is how the context lists it. */
export function save(name: string, text: string) {
  const item = context().items.find((x) => x.name === name && x.editable);
  if (!item) throw new Error(`no editable item named ${JSON.stringify(name)}`);
  writeFileSync(item.source, text);
  return { ...item, body: text };
}

export function context() {
  const seen = Object.entries(inventories).map(([kind, inv]) => ({ kind, model: inv.model, at: inv.at, skills: inv.skills, agents: inv.agents }));
  return { surfaces: SURFACES, items: [...instructions(), ...memories(), ...skills(), ...tools()], sessions: seen };
}
