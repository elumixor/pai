import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { bus } from "./bus.ts";

/**
 * Long-term memory: one markdown file per fact under the workspace, shared by every
 * session. Files are the source of truth; the index is derived from their frontmatter and
 * appended to each session's system prompt, so a fresh session knows what is on file
 * without reading anything.
 */

export const MEMORY_TYPES = ["user", "person", "preference", "project", "reference", "fact"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export interface Memory {
  readonly name: string;
  readonly type: MemoryType;
  readonly description: string;
  readonly body: string;
  readonly updatedAt: string;
}

const dir = join(config.workspace, "memory");
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;
const MAX_NAME = 60;
const MAX_RESULTS = 8;

export class MemoryNameError extends Error {
  constructor(name: string) {
    super(`invalid memory name "${name}": lowercase words joined by dashes, at most ${MAX_NAME} characters`);
  }
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_NAME);

const pathOf = (name: string) => join(dir, `${name}.md`);

function parse(name: string, raw: string): Memory {
  const m = FRONTMATTER.exec(raw);
  const meta: Record<string, string> = {};
  for (const line of (m?.[1] ?? "").split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const type = (MEMORY_TYPES as readonly string[]).includes(meta.type ?? "") ? (meta.type as MemoryType) : "fact";
  return { name, type, description: meta.description ?? "", body: (m?.[2] ?? raw).trim(), updatedAt: meta.updated ?? "" };
}

function serialize(m: Memory): string {
  return `---\nname: ${m.name}\ntype: ${m.type}\ndescription: ${m.description}\nupdated: ${m.updatedAt}\n---\n\n${m.body}\n`;
}

export function all(): readonly Memory[] {
  mkdirSync(dir, { recursive: true });
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => parse(f.slice(0, -3), readFileSync(join(dir, f), "utf8")))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function get(name: string): Memory | undefined {
  return all().find((m) => m.name === name);
}

export interface Remember {
  readonly name: string;
  readonly type: MemoryType;
  readonly description: string;
  readonly body: string;
  /** Session that saved it; the main conversation is told about saves made elsewhere. */
  readonly by?: string;
}

/** Creates or replaces one memory. */
export function remember(input: Remember): Memory {
  const name = slugify(input.name);
  if (!NAME.test(name)) throw new MemoryNameError(input.name);
  const existed = get(name) !== undefined;
  const memory: Memory = {
    name,
    type: input.type,
    description: input.description.replace(/\s+/g, " ").trim(),
    body: input.body.trim(),
    updatedAt: new Date().toISOString().slice(0, 10),
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(pathOf(name), serialize(memory));
  bus.emitEvent("memory.saved", { name, type: memory.type, description: memory.description, updated: existed }, input.by);
  return memory;
}

export function forget(name: string, by?: string): boolean {
  if (!get(name)) return false;
  rmSync(pathOf(name));
  bus.emitEvent("memory.forgotten", { name }, by);
  return true;
}

/** Memories whose name, description, or body mention the query words, best match first. */
export function recall(query: string): readonly Memory[] {
  const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 1);
  if (words.length === 0) return all();
  return all()
    .map((m) => {
      const head = `${m.name} ${m.description}`.toLowerCase();
      const body = m.body.toLowerCase();
      const score = words.reduce((n, w) => n + (head.includes(w) ? 2 : 0) + (body.includes(w) ? 1 : 0), 0);
      return { m, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RESULTS)
    .map((x) => x.m);
}

/** One line per memory, for the system prompt. */
export function index(): string {
  const lines = all().map((m) => `- ${m.name} (${m.type}): ${m.description}`);
  return lines.length ? lines.join("\n") : "(nothing saved yet)";
}
