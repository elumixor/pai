import { readdirSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, join } from "node:path";
import { config } from "../core/config.ts";
import { db, now } from "../core/db.ts";
import { logger } from "../core/log.ts";

const log = logger("catalog");

export interface Project {
  slug: string;
  path: string;
  summary: string;
  aliases: string[];
  /** A repo under devRoot, or a context: a directory under the workspace with instructions and memory of its own. */
  kind: "repo" | "context";
  /** The repository on the web, when `origin` points at one. */
  repo?: string;
}

export const contextsDir = () => join(config.workspace, "projects");

const CONTEXT_TEMPLATE = (name: string, about: string) => `# ${name}

${about || "What this project is for."}

## Voice

How to write here: tone, length, language, what to avoid.

## Preferences

Standing decisions and constraints. Facts that change go to memory (remember with scope "project").
`;

/** A project that is not a repository: a directory with a CLAUDE.md, so a session in it has a voice and rules. */
export function createContext(name: string, about = ""): Project {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) throw new CloneError("a project needs a name");
  const target = join(contextsDir(), slug);
  if (existsSync(target)) throw new CloneError(`${target} already exists`);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "CLAUDE.md"), CONTEXT_TEMPLATE(name.trim(), about.trim()));
  refresh();
  const project = get(slug);
  if (!project) throw new CloneError(`created ${target}, but it did not index`);
  return project;
}

function findContexts(): string[] {
  const dir = contextsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => join(dir, e.name));
}

export class CloneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloneError";
  }
}

const repoUrls = new Map<string, string | undefined>();

/** `git@github.com:me/thing.git` and `https://github.com/me/thing.git` both become the page. */
function remoteUrl(path: string): string | undefined {
  if (repoUrls.has(path)) return repoUrls.get(path);
  const raw = read(join(path, ".git", "config"))?.match(/\[remote "origin"\][^[]*?url\s*=\s*(\S+)/)?.[1];
  // `github.com-personal` and the like are ssh host aliases for the same site.
  const url = raw
    ?.replace(/^git@([^:]+):/, "https://$1/")
    .replace(/^ssh:\/\/git@/, "https://")
    .replace(/^(https:\/\/)(github\.com|gitlab\.com|bitbucket\.org)[\w-]*\//, "$1$2/")
    .replace(/\.git$/, "");
  repoUrls.set(path, url?.startsWith("http") ? url : undefined);
  return repoUrls.get(path);
}

/**
 * Adds a project by cloning it under `devRoot`. The directory name is the repository's
 * unless one is given; an existing directory is an error rather than a merge.
 */
export function clone(url: string, name?: string): Project {
  const source = url.trim();
  if (!/^(https?:\/\/|git@|ssh:\/\/)[\w.@:/~-]+$/.test(source)) throw new CloneError("not a git url");
  const dir = (name?.trim() || basename(source).replace(/\.git$/, "")).replace(/[^\w.-]/g, "");
  if (!dir) throw new CloneError("cannot tell the directory name from that url");
  const target = join(config.devRoot, dir);
  if (existsSync(target)) throw new CloneError(`${target} already exists`);
  mkdirSync(config.devRoot, { recursive: true });
  const res = spawnSync("git", ["clone", "--quiet", source, target], { encoding: "utf8", timeout: 5 * 60 * 1000 });
  if (res.status !== 0) throw new CloneError(res.stderr.trim() || `git clone exited with ${res.status}`);
  refresh();
  const project = get(dir);
  if (!project) throw new CloneError(`cloned, but ${target} is not a project`);
  return project;
}

const IGNORED = new Set(["node_modules", ".git", "temp", "gen", "dist", "build"]);

function findRepos(root: string, depth: number, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !IGNORED.has(e.name) && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch {
    return out;
  }
  for (const name of entries) {
    const path = join(root, name);
    if (existsSync(join(path, ".git"))) {
      out.push(path);
      continue; // a repo is a leaf; nested worktrees are not separate projects
    }
    if (depth > 1) findRepos(path, depth - 1, out);
  }
  return out;
}

function read(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** First line of prose in a markdown file, ignoring headings, badges, links and boilerplate. */
function firstProse(raw: string): string | undefined {
  return raw
    .split("\n")
    .map((l) => l.trim())
    .find(
      (l) =>
        l.length > 20 &&
        !l.startsWith("#") &&
        !l.startsWith("!") &&
        !l.startsWith("<") &&
        !l.startsWith("[") &&
        !l.startsWith("-") &&
        !l.startsWith("*") &&
        !l.startsWith("|") &&
        !l.startsWith(">") &&
        !l.startsWith("```") &&
        !/^this file provides guidance/i.test(l),
    );
}

function describe(path: string): string {
  const parts: string[] = [];

  const readme = read(join(path, "README.md")) ?? read(join(path, "readme.md"));
  if (readme) {
    const title = /^#\s+(.+)$/m.exec(readme)?.[1];
    const prose = firstProse(readme);
    if (title) parts.push(title.trim());
    if (prose) parts.push(prose);
  }

  if (parts.length === 0) {
    const pkgRaw = read(join(path, "package.json"));
    if (pkgRaw) {
      try {
        const pkg = JSON.parse(pkgRaw) as { description?: string };
        if (pkg.description) parts.push(pkg.description);
      } catch {
        /* malformed package.json is not worth failing the scan over */
      }
    }
  }

  if (parts.length === 0) {
    const claude = read(join(path, "CLAUDE.md"));
    const prose = claude ? firstProse(claude) : undefined;
    if (prose) parts.push(prose);
  }

  const tech = stack(path);
  if (tech) parts.push(tech);

  return parts.join(" — ").replace(/\s+/g, " ").slice(0, 240);
}

function stack(path: string): string | undefined {
  let entries: string[] = [];
  try {
    entries = readdirSync(path);
  } catch {
    return undefined;
  }
  if (entries.some((f) => f.endsWith(".xcodeproj") || f.endsWith(".xcworkspace"))) return "iOS/Xcode";
  if (entries.includes("Package.swift")) return "Swift package";
  if (entries.includes("pubspec.yaml")) return "Flutter";
  if (entries.includes("Cargo.toml")) return "Rust";
  if (entries.includes("pyproject.toml") || entries.includes("requirements.txt")) return "Python";
  if (entries.includes("go.mod")) return "Go";
  return undefined;
}

/** Slug is the directory name unless that collides, then it is parent/name. */
function slugFor(path: string, taken: Set<string>): string {
  const name = basename(path);
  if (!taken.has(name)) return name;
  return `${basename(join(path, ".."))}/${name}`;
}

interface Override {
  summary?: string;
  aliases?: string[];
}

/**
 * Hand-written descriptions and aliases, merged over what the scanner infers.
 * Repos without a README route badly; this is the escape hatch, and builder can
 * edit it on itself.
 */
function overrides(): Record<string, Override> {
  const raw = read(join(import.meta.dir, "../..", "projects.json"));
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, Override>;
  } catch {
    log.warn("projects.json is not valid JSON — ignoring");
    return {};
  }
}

export function scan(): Project[] {
  const repos = findRepos(config.devRoot, config.scanDepth);
  // The daemon's own checkout is a project too, wherever it lives: changes to pai are coding work like any other.
  if (existsSync(join(config.repo, ".git")) && !repos.includes(config.repo)) repos.push(config.repo);
  repos.sort();
  const contexts = findContexts().sort();
  const custom = overrides();
  const taken = new Set<string>();
  const projects: Project[] = [];
  for (const [kind, paths] of [["repo", repos], ["context", contexts]] as const)
    for (const path of paths) {
      const slug = slugFor(path, taken);
      taken.add(slug);
      const over = custom[slug] ?? {};
      projects.push({
        slug,
        path,
        kind,
        summary: over.summary ?? describe(path),
        aliases: [...new Set([...aliasesFor(slug), ...(over.aliases ?? [])])],
      });
    }
  return projects;
}

function aliasesFor(slug: string): string[] {
  const base = basename(slug).toLowerCase();
  const set = new Set<string>([base]);
  // "balance-app" also answers to "balance" and "balanceapp"
  set.add(base.replace(/-/g, ""));
  set.add(base.replace(/-(app|web|api|site|bot)$/, ""));
  set.delete("");
  return [...set];
}

export function refresh(): Project[] {
  const projects = scan();
  const ts = now();
  const upsert = db.prepare(
    `INSERT INTO projects (slug, path, summary, aliases, kind, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET path=excluded.path, summary=excluded.summary,
       aliases=excluded.aliases, kind=excluded.kind, updated_at=excluded.updated_at`,
  );
  const tx = db.transaction((items: Project[]) => {
    for (const p of items) upsert.run(p.slug, p.path, p.summary, JSON.stringify(p.aliases), p.kind, ts);
    db.prepare("DELETE FROM projects WHERE updated_at < ?").run(ts);
  });
  tx(projects);
  log.info(`indexed ${projects.length} projects under ${config.devRoot}`);
  return projects;
}

export function all(): Project[] {
  const rows = db.query("SELECT slug, path, summary, aliases, kind FROM projects ORDER BY slug").all() as {
    slug: string;
    path: string;
    summary: string;
    aliases: string;
    kind: "repo" | "context";
  }[];
  return rows.map((r) => ({ ...r, aliases: JSON.parse(r.aliases) as string[], repo: r.kind === "repo" ? remoteUrl(r.path) : undefined }));
}

export function get(slug: string): Project | undefined {
  return all().find((p) => p.slug === slug || basename(p.slug) === slug);
}

/** Compact, byte-stable catalog for the router prompt. */
export function catalogText(projects = all()): string {
  return projects.map((p) => `- ${p.slug}: ${p.summary || "(no description)"}`).join("\n");
}
