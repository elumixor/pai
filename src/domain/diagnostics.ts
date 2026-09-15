import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { logger } from "../core/log.ts";
import { config } from "../core/config.ts";

const log = logger("diagnostics");

/**
 * Type errors for one file, from the TypeScript compiler run on the project that holds it
 * (the nearest tsconfig.json). A whole-project check takes seconds, so a project's result
 * is kept for a while and shared between files; saving a file asks for a fresh one.
 */

export interface Diagnostic {
  readonly line: number;
  readonly column: number;
  readonly message: string;
  readonly severity: "error" | "warning";
  readonly code: string;
}

const TTL = 60 * 1000;
const cache = new Map<string, { at: number; byFile: Map<string, Diagnostic[]> }>();
const inFlight = new Map<string, Promise<Map<string, Diagnostic[]>>>();

/** The nearest directory above the file with a tsconfig.json, stopping at the dev root or the workspace. */
function projectOf(file: string): string | undefined {
  let dir = dirname(resolve(file));
  const stops = [config.devRoot, config.workspace, "/"];
  for (;;) {
    if (existsSync(join(dir, "tsconfig.json"))) return dir;
    if (stops.includes(dir)) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

const LINE = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/;

async function check(project: string): Promise<Map<string, Diagnostic[]>> {
  const proc = Bun.spawn([process.execPath, "x", "tsc", "--noEmit", "--pretty", "false", "-p", project], { cwd: project, stdout: "pipe", stderr: "pipe", env: { ...process.env } });
  const timer = setTimeout(() => proc.kill(), 90_000);
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  clearTimeout(timer);
  const byFile = new Map<string, Diagnostic[]>();
  let current: { file: string; item: Diagnostic } | undefined;
  for (const raw of out.split("\n")) {
    const m = LINE.exec(raw);
    if (m) {
      const file = resolve(project, m[1]!);
      current = { file, item: { line: Number(m[2]), column: Number(m[3]), severity: m[4] as Diagnostic["severity"], code: m[5]!, message: m[6]! } };
      byFile.set(file, [...(byFile.get(file) ?? []), current.item]);
    } else if (current && raw.startsWith("  ")) {
      // Continuation lines of a multi-line message.
      const list = byFile.get(current.file)!;
      list[list.length - 1] = { ...current.item, message: `${current.item.message}\n${raw.trim()}` };
      current.item = list[list.length - 1]!;
    }
  }
  log.debug(`${project}: ${[...byFile.values()].flat().length} diagnostics`);
  return byFile;
}

export async function diagnostics(file: string, fresh = false): Promise<{ project?: string; items: Diagnostic[] }> {
  const project = projectOf(file);
  if (!project) return { items: [] };
  const known = cache.get(project);
  if (!fresh && known && Date.now() - known.at < TTL) return { project, items: known.byFile.get(resolve(file)) ?? [] };
  let pending = inFlight.get(project);
  if (!pending) {
    pending = check(project).finally(() => inFlight.delete(project));
    inFlight.set(project, pending);
  }
  const byFile = await pending;
  cache.set(project, { at: Date.now(), byFile });
  return { project, items: byFile.get(resolve(file)) ?? [] };
}
