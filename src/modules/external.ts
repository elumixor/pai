/**
 * Modules from their own repositories, as `pai.config.ts` names them: installed under
 * `modules/<name>/` (a clone, or a link to a path), loaded into the daemon at start, with
 * one context each. A module that fails to load is reported, not fatal.
 */
import { $ } from "bun";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { config } from "../core/config.ts";
import { bus, type PaiEvent } from "../core/bus.ts";
import { db, kv } from "../core/db.ts";
import { logger } from "../core/log.ts";
import { sdk, type CliContext, type ModuleContext, type ModuleExport, type ModuleHealth, type PaiConfig, type PaiModule } from "./sdk.ts";

const log = logger("modules");
export const modulesDir = join(config.repo, "modules");

export interface Loaded {
  readonly name: string;
  readonly source: string;
  readonly dir: string;
  readonly module?: PaiModule;
  readonly ctx?: ModuleContext;
  readonly error?: string;
  started?: boolean;
}

const loaded = new Map<string, Loaded>();

/** `pai.config.ts`, with `pai.config.local.ts` (not committed) overriding entries: a path to a checkout while working on a module. */
export async function readConfig(): Promise<PaiConfig> {
  const read = async (file: string): Promise<Partial<PaiConfig>> => {
    const path = join(config.repo, file);
    if (!existsSync(path)) return {};
    const mod = (await import(path)) as { default?: PaiConfig };
    return mod.default ?? {};
  };
  const base = await read("pai.config.ts");
  const local = await read("pai.config.local.ts");
  return { modules: { ...(base.modules ?? {}), ...(local.modules ?? {}) } };
}

export const dirOf = (name: string) => join(modulesDir, name);
export const isInstalled = (name: string) => existsSync(join(dirOf(name), "index.ts"));

/** `github:owner/repo#ref` → an ssh clone url and the ref; a path stays a path. */
function parseSource(source: string): { kind: "git"; url: string; ref?: string } | { kind: "path"; path: string } {
  if (source.startsWith("github:")) {
    const [repo, ref] = source.slice(7).split("#");
    return { kind: "git", url: `git@github.com:${repo}.git`, ref };
  }
  if (/^(git@|git\+|https?:\/\/|ssh:\/\/)/.test(source)) {
    const [url, ref] = source.replace(/^git\+/, "").split("#");
    return { kind: "git", url: url!, ref };
  }
  return { kind: "path", path: resolve(config.repo, source.replace(/^~/, process.env.HOME ?? "")) };
}

export async function install(name: string, source: string) {
  mkdirSync(modulesDir, { recursive: true });
  const dir = dirOf(name);
  const parsed = parseSource(source);
  if (parsed.kind === "path") {
    if (!existsSync(parsed.path)) throw new Error(`${name}: ${parsed.path} does not exist`);
    if (existsSync(dir) || isLink(dir)) rmSync(dir, { recursive: true, force: true });
    symlinkSync(parsed.path, dir);
    log.info(`${name}: linked to ${parsed.path}`);
  } else if (!existsSync(dir)) {
    const res = await $`git clone --quiet ${parsed.url} ${dir}`.nothrow().quiet();
    if (res.exitCode !== 0) throw new Error(`${name}: clone failed: ${res.stderr.toString().trim().split("\n").pop()}`);
    if (parsed.ref) await $`git -C ${dir} checkout --quiet ${parsed.ref}`.quiet();
    log.info(`${name}: cloned ${parsed.url}`);
  }
  await dependencies(dir);
  return dir;
}

const isLink = (path: string) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

async function dependencies(dir: string) {
  const pkg = join(dir, "package.json");
  if (!existsSync(pkg)) return;
  const manifest = (await Bun.file(pkg).json()) as { dependencies?: Record<string, string> };
  if (!manifest.dependencies || !Object.keys(manifest.dependencies).length) return;
  const res = await $`${process.execPath} install`.cwd(dir).nothrow().quiet();
  if (res.exitCode !== 0) throw new Error(`bun install in ${dir}: ${res.stderr.toString().trim().slice(-300)}`);
}

/** Pulls a cloned module; a linked one is whatever its checkout is. Returns whether the head moved. */
export async function update(name: string) {
  const dir = dirOf(name);
  if (!existsSync(join(dir, ".git")) || isLink(dir)) return { updated: false, reason: "not a clone" };
  const before = (await $`git -C ${dir} rev-parse --short HEAD`.quiet()).stdout.toString().trim();
  const res = await $`git -C ${dir} pull --ff-only --quiet`.nothrow().quiet();
  if (res.exitCode !== 0) return { updated: false, reason: res.stderr.toString().trim().split("\n").pop() };
  const after = (await $`git -C ${dir} rev-parse --short HEAD`.quiet()).stdout.toString().trim();
  if (after !== before) await dependencies(dir);
  return { updated: after !== before, from: before, to: after };
}

export function remove(name: string) {
  rmSync(dirOf(name), { recursive: true, force: true });
}

function contextFor(name: string, dir: string): ModuleContext {
  const dataDir = join(config.repo, "data", "modules", name);
  mkdirSync(dataDir, { recursive: true });
  const prefix = `module:${name}:`;
  return {
    name,
    dir,
    dataDir,
    log: logger(name),
    db,
    config: { repo: config.repo, workspace: config.workspace, devRoot: config.devRoot, baseUrl: config.baseUrl, token: config.token },
    env: process.env,
    sessions: undefined as unknown as ModuleContext["sessions"],
    catalog: undefined as unknown as ModuleContext["catalog"],
    threads: undefined as unknown as ModuleContext["threads"],
    settings: {
      get: (key) => kv.get(prefix + key),
      set: (key, value) => (value === undefined ? kv.del(prefix + key) : kv.set(prefix + key, value)),
    },
    on: (listener) => {
      bus.on("event", listener);
      return () => bus.off("event", listener);
    },
    emit: (kind, payload, sessionId) => void bus.emitEvent(kind, payload, sessionId),
    use: <T>(other: string): T => {
      const l = loaded.get(other);
      if (!l?.module?.api) throw new Error(`${name}: module ${other} is not loaded or has no api`);
      return l.module.api as T;
    },
  };
}

/** Configured modules ordered so that what a module requires comes before it. */
function ordered(modules: Readonly<Record<string, string>>, requiresOf: (name: string) => readonly string[]) {
  const out: string[] = [];
  const visit = (name: string, trail: string[]) => {
    if (out.includes(name)) return;
    if (trail.includes(name)) throw new Error(`modules require each other in a loop: ${[...trail, name].join(" → ")}`);
    for (const dep of requiresOf(name)) if (modules[dep]) visit(dep, [...trail, name]);
    out.push(name);
  };
  for (const name of Object.keys(modules)) visit(name, []);
  return out;
}

/** Imports every configured module, installing what is missing. Called once, by the daemon. */
export async function load() {
  const { modules } = await readConfig();
  const [sessions, catalog, transcript] = await Promise.all([import("../domain/sessions.ts"), import("../domain/catalog.ts"), import("../domain/transcript.ts")]);
  // Import everything first (to know what requires what), then register in dependency order.
  const imported = new Map<string, PaiModule>();
  for (const [name, source] of Object.entries(modules)) {
    try {
      if (!isInstalled(name)) await install(name, source);
      imported.set(name, await importModule(dirOf(name)));
    } catch (err) {
      log.warn(`${name}: ${(err as Error).message}`);
      loaded.set(name, { name, source, dir: dirOf(name), error: (err as Error).message });
    }
  }
  for (const name of ordered(modules, (n) => imported.get(n)?.requires ?? [])) {
    const module = imported.get(name);
    if (!module) continue;
    const missing = (module.requires ?? []).filter((dep) => !imported.has(dep));
    if (missing.length) {
      loaded.set(name, { name, source: modules[name]!, dir: dirOf(name), error: `requires ${missing.join(", ")}` });
      continue;
    }
    const dir = dirOf(name);
    const ctx = { ...contextFor(name, dir), sessions, catalog, threads: transcript.allThreads } as ModuleContext;
    loaded.set(name, { name, source: modules[name]!, dir, module, ctx });
    linkSkills(module, dir);
  }
  return [...loaded.values()];
}

/**
 * A module resolves `pai/src/…` and pai's dependencies (the Agent SDK, zod, grammy, …)
 * through its `node_modules`: a link to pai's own, which carries a `pai` link to this
 * checkout. Made in the module's real directory, so a checkout elsewhere works too. A module
 * with dependencies of its own keeps its `node_modules` and gets links to what pai has.
 */
function linkPai(dir: string) {
  const real = realpathSync(dir);
  const paiModules = join(config.repo, "node_modules");
  const self = join(paiModules, "pai");
  if (!isLink(self)) symlinkSync(config.repo, self);
  const own = join(real, "node_modules");
  const manifest = existsSync(join(real, "package.json")) ? (JSON.parse(readFileSync(join(real, "package.json"), "utf8")) as { dependencies?: Record<string, string> }) : {};
  if (Object.keys(manifest.dependencies ?? {}).length) {
    mkdirSync(own, { recursive: true });
    for (const name of readdirSync(paiModules)) {
      if (name.startsWith(".") || existsSync(join(own, name))) continue;
      if (name.startsWith("@")) {
        mkdirSync(join(own, name), { recursive: true });
        for (const sub of readdirSync(join(paiModules, name))) if (!existsSync(join(own, name, sub))) symlinkSync(join(paiModules, name, sub), join(own, name, sub));
      } else symlinkSync(join(paiModules, name), join(own, name));
    }
    return;
  }
  if (isLink(own)) {
    if (readlinkSync(own) === paiModules) return;
    rmSync(own);
  } else if (existsSync(own)) rmSync(own, { recursive: true, force: true });
  symlinkSync(paiModules, own);
}

/** `index.ts`, made with the sdk when it is a factory. */
async function importModule(dir: string): Promise<PaiModule> {
  linkPai(dir);
  const mod = (await import(join(dir, "index.ts"))) as { default?: ModuleExport };
  const made = typeof mod.default === "function" ? mod.default(sdk) : mod.default;
  if (!made?.name) throw new Error("index.ts has no default export with a name");
  return made;
}

/** A module's skills appear in the workspace as `<name>-<skill>`, which is where sessions look. */
function linkSkills(module: PaiModule, dir: string) {
  if (!module.skills) return;
  const from = join(dir, module.skills);
  if (!existsSync(from)) return;
  const into = join(config.workspace, ".claude", "skills");
  mkdirSync(into, { recursive: true });
  for (const skill of readdirSync(from)) {
    if (!existsSync(join(from, skill, "SKILL.md"))) continue;
    const link = join(into, `${module.name}-${skill}`);
    if (isLink(link) || existsSync(link)) rmSync(link, { recursive: true, force: true });
    symlinkSync(join(from, skill), link);
  }
}

export const all = () => [...loaded.values()];
export const get = (name: string) => loaded.get(name);
export const active = () => all().filter((l): l is Loaded & { module: PaiModule; ctx: ModuleContext } => Boolean(l.module && l.ctx) && (l.module!.enabled?.(l.ctx!) ?? true));

export async function startAll() {
  for (const l of active()) {
    try {
      await l.module.start?.(l.ctx);
      l.started = true;
    } catch (err) {
      log.warn(`${l.name}: start failed: ${(err as Error).message}`);
      loaded.set(l.name, { ...l, error: `start failed: ${(err as Error).message}` });
    }
  }
}

export async function stopAll() {
  for (const l of active()) if (l.started) await Promise.resolve(l.module.stop?.()).catch((err: Error) => log.warn(`${l.name}: stop: ${err.message}`));
}

export async function health(name: string): Promise<ModuleHealth> {
  const l = loaded.get(name);
  if (!l) return { ok: false, detail: "not configured" };
  if (l.error) return { ok: false, detail: l.error };
  if (!l.module?.health) return { ok: true };
  return Promise.resolve(l.module.health()).catch((err: Error) => ({ ok: false, detail: err.message }));
}

export async function describe() {
  return Promise.all(
    all().map(async (l) => ({
      name: l.name,
      source: l.source,
      installed: isInstalled(l.name),
      linked: isLink(l.dir),
      title: l.module?.title,
      description: l.module?.description,
      kind: l.module?.kind ?? "tools",
      enabled: l.module && l.ctx ? (l.module.enabled?.(l.ctx) ?? true) : false,
      started: Boolean(l.started),
      health: await health(l.name),
      tools: l.module?.tools ? { server: l.name, names: l.module.tools.names, kinds: l.module.tools.kinds } : undefined,
      prompt: l.module ? promptsOf(l.module)[0] : undefined,
      cli: Boolean(l.module?.cli),
      commands: l.module?.commands ?? [],
      requires: l.module?.requires ?? [],
      routes: Boolean(l.module?.routes),
      ui: l.module?.ui ? `/m/${l.name}/ui/` : undefined,
      settings: l.module?.settings,
      events: l.module?.events,
    })),
  );
}

/** The MCP servers external modules add to a session of `kind`. */
export function mcpServers(kind: "main" | "task" | "code", ref: import("../domain/tools.ts").SessionRef) {
  const out: Record<string, ReturnType<NonNullable<PaiModule["tools"]>["create"]>> = {};
  for (const l of active()) if (l.module.tools?.kinds.includes(kind)) out[l.name] = l.module.tools.create(ref, l.ctx);
  return out;
}

const promptsOf = (m: PaiModule) => (m.prompt ? (Array.isArray(m.prompt) ? m.prompt : [m.prompt]) : []) as readonly import("./sdk.ts").ModulePrompt[];

export const prompts = (kind: "main" | "task" | "code") =>
  active().flatMap((l) => promptsOf(l.module).filter((p) => p.kinds.includes(kind)).map((p) => p.text));

/** `/m/<name>/…` */
export async function route(req: Request, url: URL): Promise<Response | undefined> {
  const m = /^\/m\/([a-z0-9-]+)(\/.*)?$/.exec(url.pathname);
  if (!m) return undefined;
  const l = loaded.get(m[1]!);
  if (!l?.module || !l.ctx) return undefined;
  const rest = m[2] ?? "/";
  if (l.module.ui && rest.startsWith("/ui/")) {
    const file = Bun.file(join(l.dir, l.module.ui, rest.slice(4) || "index.html"));
    return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
  }
  return (await l.module.routes?.(req, rest, url, l.ctx)) ?? new Response("not found", { status: 404 });
}

/** Whether `pai <name> <sub>` is one the module wants run on the laptop. */
export async function runsHere(name: string, sub: string | undefined) {
  const { modules } = await readConfig();
  const source = modules[name];
  if (!source || !sub) return false;
  if (!isInstalled(name)) await install(name, source);
  const module = await importModule(dirOf(name)).catch(() => undefined);
  return Boolean(module?.cliHere?.includes(sub));
}

/** `pai <name> …`: the module's own command line, against the daemon's API. */
export async function runCli(name: string, args: readonly string[], api: CliContext["api"], post: CliContext["post"], out: CliContext["out"], json: boolean): Promise<number | undefined> {
  const { modules } = await readConfig();
  const source = modules[name];
  if (!source) return undefined;
  if (!isInstalled(name)) await install(name, source);
  const dir = dirOf(name);
  const module = await importModule(dir);
  if (!module.cli) throw new Error(`${name} has no command line`);
  const dataDir = join(config.repo, "data", "modules", name);
  mkdirSync(dataDir, { recursive: true });
  const { spin } = await import("../clients/spinner.ts");
  const run = async (other: string, otherArgs: readonly string[]) => (await runCli(other, otherArgs, api, post, out, json)) ?? 1;
  return (await module.cli({ name, dir, dataDir, args, json, api, post, out, spin, run })) ?? 0;
}

export type { PaiEvent };
