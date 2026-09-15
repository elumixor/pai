import { readdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import { config } from "../core/config.ts";

/**
 * Read-only filesystem access for the web app. Only the directories the assistant works
 * in are visible; everything else on the host is not the dashboard's business.
 */

const MAX_BYTES = 512 * 1024;
const MAX_ENTRIES = 500;

export class FileAccessError extends Error {
  constructor(message: string, readonly path: string) {
    super(message);
    this.name = "FileAccessError";
  }
}

export interface Root {
  readonly name: string;
  readonly path: string;
}

export function roots(): readonly Root[] {
  return [
    { name: "projects", path: config.devRoot },
    { name: "workspace", path: config.workspace },
    { name: "pai", path: config.repo },
  ];
}

function resolveWithin(path: string) {
  const absolute = normalize(isAbsolute(path) ? path : join(config.devRoot, path));
  const root = roots().find((r) => absolute === r.path || absolute.startsWith(`${r.path}/`));
  if (!root) throw new FileAccessError("outside the directories pai can show", path);
  return absolute;
}

export interface Entry {
  readonly name: string;
  readonly path: string;
  readonly directory: boolean;
  readonly size: number;
  readonly modified: string;
}

export function list(path: string): readonly Entry[] {
  const dir = resolveWithin(path);
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory())
    throw new FileAccessError("not a directory", path);

  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.name !== ".git" && entry.name !== "node_modules")
    .slice(0, MAX_ENTRIES)
    .map((entry) => {
      const full = join(dir, entry.name);
      const stats = statSync(full, { throwIfNoEntry: false });
      return {
        name: entry.name,
        path: full,
        directory: entry.isDirectory(),
        size: stats?.size ?? 0,
        modified: new Date(stats?.mtimeMs ?? 0).toISOString(),
      };
    })
    .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
}

export interface FileContents {
  readonly path: string;
  readonly text: string;
  readonly truncated: boolean;
}

export async function read(path: string): Promise<FileContents> {
  const file = resolveWithin(path);
  const stats = statSync(file, { throwIfNoEntry: false });
  if (!stats?.isFile()) throw new FileAccessError("not a file", path);

  const handle = Bun.file(file);
  const truncated = stats.size > MAX_BYTES;
  const text = truncated ? await handle.slice(0, MAX_BYTES).text() : await handle.text();
  return { path: file, text, truncated };
}

/** Saves what the editor has; the file has to exist already, this is not how files are created. */
export function write(path: string, text: string): FileContents {
  const file = resolveWithin(path);
  if (!statSync(file, { throwIfNoEntry: false })?.isFile()) throw new FileAccessError("not a file", path);
  writeFileSync(file, text);
  return { path: file, text, truncated: false };
}

const INDEX_IGNORED = new Set([".git", "node_modules", "dist", "build", "target", ".svelte-kit", ".next", "out", "coverage"]);
const MAX_INDEX = 8000;

/** Every file under a directory, relative to it, for a search box; build output and dependencies are left out. */
export function index(path: string): readonly string[] {
  const root = resolveWithin(path);
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    if (out.length >= MAX_INDEX) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (INDEX_IGNORED.has(entry.name) || (entry.name.startsWith(".") && entry.name !== ".env")) continue;
      if (entry.isDirectory()) walk(join(dir, entry.name), `${prefix}${entry.name}/`);
      else if (entry.isFile()) out.push(`${prefix}${entry.name}`);
      if (out.length >= MAX_INDEX) return;
    }
  };
  walk(root, "");
  return out;
}

/** The markdown worth reading from the dashboard: the persona, and the repo's own docs. */
export function documents(): readonly Entry[] {
  const candidates = [join(config.workspace, "CLAUDE.md"), join(config.repo, "README.md"), join(config.repo, "CLAUDE.md")];
  const docs = list(join(config.repo, "docs")).filter((entry) => entry.name.endsWith(".md"));
  const named = candidates
    .map((path) => ({ path, stats: statSync(path, { throwIfNoEntry: false }) }))
    .filter((entry) => entry.stats?.isFile())
    .map(({ path, stats }) => ({
      name: relative(resolve(config.repo, ".."), path),
      path,
      directory: false,
      size: stats?.size ?? 0,
      modified: new Date(stats?.mtimeMs ?? 0).toISOString(),
    }));
  return [...named, ...docs];
}
