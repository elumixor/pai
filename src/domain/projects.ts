import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { config } from "../core/config.ts";

/**
 * The projects a session can run in. Core knows only its own **contexts** — directories under
 * `workspace/projects/` with a `CLAUDE.md` (a voice and rules for work that is not code). Repositories
 * come from a module that registers a `ProjectSource` (pai-dev: the repos under the dev root); without
 * one there are none, and a session runs in the workspace or the cwd it was given.
 */

export interface Project {
  readonly slug: string;
  readonly path: string;
  readonly summary: string;
  readonly aliases: readonly string[];
  /** A repository (coding work, a `code` session) or a context (a directory with instructions of its own). */
  readonly kind: "repo" | "context";
  /** The repository on the web, when `origin` points at one. */
  readonly repo?: string;
}

/** What a module hands core so its projects are sessions' projects too. */
export interface ProjectSource {
  readonly all: () => readonly Project[];
  /** Read the projects again (a repo created, renamed, moved). */
  readonly refresh?: () => void;
  /** Add one from a git url; the directory name is the repository's unless `name` is given. */
  readonly clone?: (url: string, name?: string) => Project;
}

export class ProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectError";
  }
}

const sources = new Map<string, ProjectSource>();

/** Called by the module loader for a module that has `projects`. */
export const provide = (module: string, source: ProjectSource) => void sources.set(module, source);

export const contextsDir = () => join(config.workspace, "projects");

const CONTEXT_TEMPLATE = (name: string, about: string) => `# ${name}

${about || "What this project is for."}

## Voice

How to write here: tone, length, language, what to avoid.

## Preferences

Standing decisions and constraints, and what is worth remembering about this project.
`;

const slugOf = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

function firstLine(path: string) {
  const file = join(path, "CLAUDE.md");
  if (!existsSync(file)) return "";
  return (
    readFileSync(file, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("#")) ?? ""
  ).slice(0, 240);
}

function contexts(): Project[] {
  const dir = contextsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort()
    .map((name) => ({ slug: name, path: join(dir, name), kind: "context" as const, summary: firstLine(join(dir, name)), aliases: [name] }));
}

/** A project that is not a repository: a directory with a CLAUDE.md, so a session in it has a voice and rules. */
export function createContext(name: string, about = ""): Project {
  const slug = slugOf(name);
  if (!slug) throw new ProjectError("a project needs a name");
  const target = join(contextsDir(), slug);
  if (existsSync(target)) throw new ProjectError(`${target} already exists`);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "CLAUDE.md"), CONTEXT_TEMPLATE(name.trim(), about.trim()));
  const project = get(slug);
  if (!project) throw new ProjectError(`created ${target}, but it did not index`);
  return project;
}

/** Clones a repository through the module that keeps repositories. */
export function clone(url: string, name?: string): Project {
  const source = [...sources.values()].find((s) => s.clone);
  if (!source?.clone) throw new ProjectError("no module keeps repositories here (pai-dev is not loaded)");
  return source.clone(url, name);
}

/** Repositories first (each source's own order), then the contexts; a context never shadows a repo's slug. */
export function all(): Project[] {
  const repos = [...sources.values()].flatMap((s) => s.all());
  const taken = new Set(repos.map((p) => p.slug));
  return [...repos, ...contexts().filter((c) => !taken.has(c.slug))];
}

export function get(slug: string): Project | undefined {
  return all().find((p) => p.slug === slug || basename(p.slug) === slug);
}

/** The project a directory is in, when it is one or under one. */
export const containing = (cwd: string) => get(cwd) ?? all().find((p) => cwd === p.path || cwd.startsWith(`${p.path}/`));

export function refresh(): Project[] {
  for (const s of sources.values()) s.refresh?.();
  return all();
}
