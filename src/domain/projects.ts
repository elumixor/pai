import { basename } from "node:path";

/**
 * The projects a session can run in. They all come from a `ProjectSource`: dev's (the separate system: the repos
 * under the dev root, `dev.ts`); without one there are none, and a session runs in the workspace or the cwd it was given.
 */

export interface Project {
  readonly slug: string;
  readonly path: string;
  readonly summary: string;
  readonly aliases: readonly string[];
  /** A git repository (coding work, a `code` session) or a plain folder. */
  readonly kind: "repo" | "folder";
  /** The repository on the web, when `origin` points at one. */
  readonly repo?: string;
}

/** Where a set of projects comes from. */
export interface ProjectSource {
  readonly all: () => readonly Project[];
  /** Read the projects again (a repo created, renamed, moved). */
  readonly refresh?: () => void;
}

const sources = new Map<string, ProjectSource>();

export const provide = (name: string, source: ProjectSource) => void sources.set(name, source);

export const all = (): Project[] => [...sources.values()].flatMap((s) => s.all());

export function get(slug: string): Project | undefined {
  return all().find((p) => p.slug === slug || basename(p.slug) === slug);
}

/** The project a directory is in, when it is one or under one. */
export const containing = (cwd: string) => get(cwd) ?? all().find((p) => cwd === p.path || cwd.startsWith(`${p.path}/`));

export function refresh(): Project[] {
  for (const s of sources.values()) s.refresh?.();
  return all();
}
