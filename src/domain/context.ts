import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
}

const readIf = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : undefined);

/** What Claude Code reported at a session's start: the tools it has, the MCP servers and how they came up. */
export interface Inventory {
  readonly tools: readonly string[];
  readonly mcpServers: readonly { name: string; status: string }[];
  readonly skills: readonly string[];
  readonly slashCommands: readonly string[];
  readonly agents: readonly string[];
  readonly model: string;
  readonly at: string;
}

const inventories: Partial<Record<SessionKind, Inventory>> = {};

/** The session that just initialised tells what it was given; the newest per kind is what the views show. */
export function noteInit(kind: SessionKind, inventory: Inventory) {
  inventories[kind] = inventory;
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
  const status = new Map<string, string>();
  for (const kind of kinds) for (const s of inventories[kind]!.mcpServers) status.set(s.name, s.status);
  for (const [server, entry] of byServer) {
    const names = [...entry.tools].sort();
    out.push({
      kind: "tool",
      name: server || "Claude Code built-ins",
      description: server ? `MCP server, ${status.get(server) ?? "connected"} · ${names.length} tools` : `${names.length} tools`,
      source: server.startsWith("claude.ai ") ? "claude.ai connector" : server ? (modules.some((m) => m.tools?.server === server) ? `src/modules/${server}.ts` : `modules/${server}`) : "claude code",
      editable: false,
      surfaces: [...entry.kinds],
      body: names.join("\n"),
    });
  }
  // A server that came up without tools (failed, needs auth) still deserves a line.
  for (const [server, state] of status)
    if (!byServer.has(server)) out.push({ kind: "tool", name: server, description: `MCP server, ${state} · no tools`, source: server.startsWith("claude.ai ") ? "claude.ai connector" : `modules/${server}`, editable: false, surfaces: [] });
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

export function context() {
  const seen = Object.entries(inventories).map(([kind, inv]) => ({ kind, model: inv.model, at: inv.at, skills: inv.skills, agents: inv.agents }));
  return { surfaces: SURFACES, items: [...instructions(), ...memories(), ...skills(), ...tools()], sessions: seen };
}
