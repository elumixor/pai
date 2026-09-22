import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "../core/config.ts";
import { modules } from "../modules/index.ts";
import { all as allProjects } from "./catalog.ts";
import { sections } from "./prompts.ts";

/**
 * What each kind of Claude session is given, laid out so it can be read and edited in one
 * place: instructions, memories, skills, tools — and for each, which surfaces see it. The
 * surfaces are pai's own sessions (main, task, code) and a `claude` started in a terminal,
 * which gets the project's files and the user's global config but none of pai's tools.
 */

export const SURFACES = ["main", "task", "code", "terminal"] as const;
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

function instructions(): ContextItem[] {
  const out: ContextItem[] = [];
  const persona = join(config.workspace, "CLAUDE.md");
  out.push({ kind: "instruction", name: "persona (workspace/CLAUDE.md)", description: "read by every pai session, as the cwd's CLAUDE.md", source: persona, editable: true, surfaces: ["main", "task"], body: readIf(persona) });
  for (const [name, text, kinds] of sections())
    out.push({ kind: "instruction", name, description: "appended to the system prompt by src/domain/prompts.ts", source: "src/domain/prompts.ts", editable: false, surfaces: kinds, body: text });
  for (const m of modules)
    if (m.prompt && m.enabled())
      out.push({ kind: "instruction", name: `${m.title} (module)`, description: "one paragraph telling sessions the module exists", source: `src/modules/${m.name}.ts`, editable: false, surfaces: m.prompt.kinds, body: m.prompt.text });
  for (const project of allProjects()) {
    const file = join(project.path, "CLAUDE.md");
    if (existsSync(file))
      out.push({ kind: "instruction", name: `${project.slug}/CLAUDE.md`, description: project.kind === "context" ? "the project's voice and rules" : "the repo's own instructions", source: file, editable: true, surfaces: [project.kind === "context" ? "task" : "code", "terminal"], project: project.slug, body: readIf(file) });
  }
  const global = join(homedir(), ".claude", "CLAUDE.md");
  if (existsSync(global)) out.push({ kind: "instruction", name: "~/.claude/CLAUDE.md", description: "the user's global instructions — terminal sessions only, pai loads project settings alone", source: global, editable: true, surfaces: ["terminal"], body: readIf(global) });
  return out;
}

function memories(): ContextItem[] {
  const file = join(config.workspace, "MEMORY.md");
  return [{ kind: "memory", name: "MEMORY.md", description: "what the assistant remembers, a markdown file it edits itself", source: file, editable: true, surfaces: ["main", "task", "code"], body: readIf(file) ?? "" }];
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
  const out = skillsIn(join(config.workspace, ".claude", "skills"), ["main", "task"]);
  for (const project of allProjects()) out.push(...skillsIn(join(project.path, ".claude", "skills"), project.kind === "context" ? ["task", "terminal"] : ["code", "terminal"], project.slug));
  out.push(...skillsIn(join(homedir(), ".claude", "skills"), ["terminal"]));
  return out;
}

function tools(): ContextItem[] {
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
  out.push({ kind: "tool", name: "claude.ai connectors (Gmail, Calendar, Drive, Notion, …)", description: "whatever is connected in the Claude account on the box", source: "claude.ai", editable: false, surfaces: ["main", "task", "code", "terminal"] });
  out.push({ kind: "tool", name: "Claude Code built-ins (Bash, Read, Edit, WebSearch, …)", description: "the standard tool set", source: "claude code", editable: false, surfaces: ["main", "task", "code", "terminal"] });
  return out;
}

export function context() {
  return { surfaces: SURFACES, items: [...instructions(), ...memories(), ...skills(), ...tools()] };
}
