/**
 * Connectors, as `pai.config.ts` names them: each its own repository implementing `@desk/connector`,
 * installed under `modules/<name>/` (a clone with its own dependencies, or a link to a checkout), imported
 * at start and handed a `Host` (`host.ts`). A connector that fails to install, load or start is reported,
 * never fatal. pai turns their tools into one MCP server each, their instructions into prompt paragraphs,
 * serves their routes, and lists them for the clients (`GET /connectors`, `GET /modules`).
 */
import { $ } from "bun";
import { createSdkMcpServer, tool as sdkTool } from "@anthropic-ai/claude-agent-sdk";
import { broken, problemsOf, startOrder, type Cli, type Connector, type Health, type Host } from "@desk/connector";
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { config } from "../core/config.ts";
import { logger } from "../core/log.ts";
import { dataDirOf, hostFor } from "./host.ts";
import type { SessionRef } from "../domain/tools.ts";

const log = logger("connectors");

export interface PaiConfig {
  /** name → where it lives: `github:owner/repo[#ref]`, a git url, or a path (absolute, `~/…`, or relative to the repo). */
  readonly connectors: Readonly<Record<string, string>>;
}

/** `PAI_MODULES_DIR` and `PAI_MODULES_CONFIG` point a scratch daemon at connectors of its own. */
export const modulesDir = resolve(process.env.PAI_MODULES_DIR ?? join(config.repo, "modules"));

export interface Loaded {
  readonly name: string;
  readonly source: string;
  readonly dir: string;
  readonly connector?: Connector;
  readonly host?: Host;
  readonly error?: string;
  started?: boolean;
}

const loaded = new Map<string, Loaded>();
/** As `pai.config.ts` lists them: the order the clients show, not the order they start in. */
let listing: readonly string[] = [];

/** One config file's connectors; `modules` is the key it had before connectors had a protocol of their own. */
const entriesOf = (c: Partial<PaiConfig> & { modules?: Record<string, string> }) => ({ ...(c.modules ?? {}), ...(c.connectors ?? {}) });

/**
 * `pai.config.ts`, with `pai.config.local.ts` (not committed) overriding entries: a path to a checkout while
 * working on a connector. `PAI_MODULES_CONFIG` names one file that replaces both.
 */
export async function readConfig(): Promise<PaiConfig> {
  const read = async (path: string) => (existsSync(path) ? entriesOf(((await import(path)) as { default?: PaiConfig }).default ?? {}) : {});
  const only = process.env.PAI_MODULES_CONFIG;
  if (only) return { connectors: await read(resolve(only)) };
  return { connectors: { ...(await read(join(config.repo, "pai.config.ts"))), ...(await read(join(config.repo, "pai.config.local.ts"))) } };
}

export const dirOf = (name: string) => join(modulesDir, name);
export const isInstalled = (name: string) => existsSync(join(dirOf(name), "index.ts"));

/** `github:owner/repo#ref` → an ssh clone url and the ref; a path stays a path. */
export function parseSource(source: string): { kind: "git"; url: string; ref?: string } | { kind: "path"; path: string } {
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

const isLink = (path: string) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

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
  await dependencies(dir, true);
  return dir;
}

/**
 * A connector's own dependencies (`@desk/connector` and whatever it uses), installed in its checkout. A checkout
 * from before connectors had their own (its `node_modules` a link into pai's, or holding a link back to pai) is
 * cleared first, so nothing is ever installed into pai's tree.
 */
async function dependencies(dir: string, force = false) {
  if (!existsSync(join(dir, "package.json"))) return;
  const own = join(dir, "node_modules");
  const stale = isLink(own) || existsSync(join(own, "@desk", "pai"));
  if (stale) rmSync(own, { recursive: true, force: true });
  if (!force && !stale && existsSync(join(own, "@desk", "connector"))) return;
  const res = await $`${process.execPath} install`.cwd(dir).nothrow().quiet();
  if (res.exitCode !== 0) throw new Error(`bun install in ${dir}: ${res.stderr.toString().trim().slice(-300)}`);
}

/**
 * Pulls a cloned connector (onto the configured remote, so a renamed repository is followed); a linked one is
 * whatever its checkout is. Returns whether the head moved.
 */
export async function update(name: string, source?: string) {
  const dir = dirOf(name);
  if (!existsSync(join(dir, ".git")) || isLink(dir)) return { updated: false, reason: "not a clone" };
  const parsed = source ? parseSource(source) : undefined;
  if (parsed?.kind === "git") {
    const current = (await $`git -C ${dir} remote get-url origin`.nothrow().quiet()).stdout.toString().trim();
    if (current && current !== parsed.url) await $`git -C ${dir} remote set-url origin ${parsed.url}`.nothrow().quiet();
  }
  const before = (await $`git -C ${dir} rev-parse --short HEAD`.quiet()).stdout.toString().trim();
  const res = await $`git -C ${dir} pull --ff-only --quiet`.nothrow().quiet();
  if (res.exitCode !== 0) return { updated: false, reason: res.stderr.toString().trim().split("\n").pop() };
  const after = (await $`git -C ${dir} rev-parse --short HEAD`.quiet()).stdout.toString().trim();
  await dependencies(dir, after !== before);
  return { updated: after !== before, from: before, to: after };
}

export function remove(name: string) {
  rmSync(dirOf(name), { recursive: true, force: true });
}

/** `index.ts`'s default export, checked against the protocol. */
async function importConnector(dir: string): Promise<Connector> {
  await dependencies(dir);
  const mod = (await import(join(dir, "index.ts"))) as { default?: unknown };
  const problems = problemsOf(mod.default);
  if (problems.length) throw new Error(`index.ts is not a connector: ${problems.join("; ")}`);
  return mod.default as Connector;
}

/** What another loaded connector exports as its `api`. */
const apiOf = <T>(asking: string, other: string): T => {
  const l = loaded.get(other);
  if (!l?.connector?.api) throw new Error(`${asking}: connector ${other} is not loaded or has no api`);
  return l.connector.api as T;
};

/** Imports every configured connector, installing what is missing. Called once, by the daemon. */
export async function load() {
  const { connectors } = await readConfig();
  listing = Object.keys(connectors);
  const imported = new Map<string, Connector>();
  for (const [name, source] of Object.entries(connectors)) {
    try {
      if (!isInstalled(name)) await install(name, source);
      imported.set(name, await importConnector(dirOf(name)));
    } catch (err) {
      log.warn(`${name}: ${(err as Error).message}`);
      loaded.set(name, { name, source, dir: dirOf(name), error: (err as Error).message });
    }
  }
  for (const name of startOrder(listing, (n) => imported.get(n)?.requires ?? [])) {
    const connector = imported.get(name);
    if (!connector) continue;
    const missing = (connector.requires ?? []).filter((dep) => !imported.has(dep));
    if (missing.length) {
      loaded.set(name, { name, source: connectors[name]!, dir: dirOf(name), error: `requires ${missing.join(", ")}` });
      continue;
    }
    loaded.set(name, { name, source: connectors[name]!, dir: dirOf(name), connector, host: hostFor(name, (other) => apiOf(name, other)) });
  }
  return [...loaded.values()];
}

export const all = () => [...loaded.values()];
const listed = () => all().sort((a, b) => listing.indexOf(a.name) - listing.indexOf(b.name));
export const get = (name: string) => loaded.get(name);
/** What a loaded connector exports as its `api`, for pai's own code; undefined when it is not loaded. */
export const api = <T>(name: string): T | undefined => loaded.get(name)?.connector?.api as T | undefined;
const serverOf = (l: Loaded) => l.connector?.server ?? l.name;
type Live = Loaded & { connector: Connector; host: Host };
const enabled = (l: Live) => {
  try {
    return l.connector.enabled?.(l.host) ?? true;
  } catch {
    return false;
  }
};
export const active = () => all().filter((l): l is Live => Boolean(l.connector && l.host) && enabled(l as Live));

export async function startAll() {
  for (const name of startOrder(listing, (n) => loaded.get(n)?.connector?.requires ?? [])) {
    const l = active().find((x) => x.name === name);
    if (!l) continue;
    try {
      await l.connector.start?.(l.host);
      l.started = true;
    } catch (err) {
      log.warn(`${l.name}: start failed: ${(err as Error).message}`);
      loaded.set(l.name, { ...l, error: `start failed: ${(err as Error).message}` });
    }
  }
}

export async function stopAll() {
  for (const l of active()) if (l.started) await Promise.resolve(l.connector.stop?.()).catch((err: Error) => log.warn(`${l.name}: stop: ${err.message}`));
}

export async function health(name: string): Promise<Health> {
  const l = loaded.get(name);
  if (!l) return { ok: false, detail: "not configured" };
  if (l.error) return { ok: false, detail: l.error };
  if (!l.connector?.health) return { ok: true };
  return Promise.resolve(l.connector.health()).catch((err: Error) => ({ ok: false, detail: err.message }));
}

/**
 * The status of one connector, whatever state it is in: one that failed to load or to answer is broken. A capability
 * without a status of its own answers with its health: working is signed in, failing is broken.
 */
async function statusOf(l: Loaded) {
  if (l.error) return broken(l.error);
  if (l.connector && !l.connector.status && l.connector.kind === "capability") {
    const h = await health(l.name);
    return h.ok ? { state: "signed_in" as const, detail: h.detail } : broken(h.detail ?? "not working");
  }
  if (!l.connector?.status || !l.host) return broken("has no status");
  const host = l.host;
  return Promise.resolve()
    .then(() => l.connector!.status!(host))
    .catch((err: Error) => broken(err.message));
}

/** Every configured connector as the dashboard draws it. */
export async function describe() {
  return Promise.all(
    listed().map(async (l) => ({
      name: l.name,
      source: l.source,
      installed: isInstalled(l.name),
      linked: isLink(l.dir),
      title: l.connector?.title,
      description: l.connector?.description,
      kind: l.connector?.kind ?? "connector",
      enabled: l.connector && l.host ? enabled(l as Live) : false,
      started: Boolean(l.started),
      health: await health(l.name),
      tools: l.connector?.tools?.length ? { server: serverOf(l), names: l.connector.tools.map((t) => t.name), kinds: KINDS } : undefined,
      prompt: l.connector?.instructions ? { text: l.connector.instructions, kinds: KINDS } : undefined,
      cli: Boolean(l.connector?.cli),
      commands: l.connector?.commands ?? [],
      verbs: [],
      requires: l.connector?.requires ?? [],
      routes: Boolean(l.connector?.routes),
      ui: l.connector?.ui ? `/m/${l.name}/ui/` : undefined,
      settings: l.connector?.settings,
      events: l.connector?.events,
      accounts: l.connector?.accounts && l.host ? { items: l.connector.accounts.list(l.host), connectPath: l.connector.accounts.connectPath, removePath: l.connector.accounts.removePath, hint: l.connector.accounts.hint } : undefined,
    })),
  );
}

/** Every connector in one shape, channels and capabilities alike: what clients draw a connectors page from. */
export async function connectors() {
  return Promise.all(
    listed().map(async (l) => ({
      name: l.name,
      kind: l.connector?.kind ?? "connector",
      title: l.connector?.title ?? l.name,
      description: l.connector?.description ?? "",
      status: await statusOf(l),
      events: l.connector?.events ?? [],
      tools: l.connector?.tools?.map((t) => t.name) ?? [],
      canSend: Boolean(l.connector?.send),
    })),
  );
}

/** The session kinds connectors reach: the chat and the builder threads, the same tools in both. */
const KINDS = ["chat", "code"] as const;

/** The MCP servers connectors add to a session: one per connector with tools, the caller passed to each tool as its agent. */
export function mcpServers(_kind: "chat" | "code", ref: SessionRef) {
  const out: Record<string, ReturnType<typeof createSdkMcpServer>> = {};
  for (const l of active()) {
    if (!l.connector.tools?.length) continue;
    out[serverOf(l)] = createSdkMcpServer({
      name: serverOf(l),
      version: "1.0.0",
      tools: l.connector.tools.map((t) => sdkTool(t.name, t.description, t.input, async (args) => (await t.run(args, { agent: ref.session?.agent ?? undefined })) as any)),
    });
  }
  return out;
}

/** Each connector's paragraph for a session, with the connector it comes from. */
export const prompts = (_kind: "chat" | "code") => active().flatMap((l) => (l.connector.instructions ? [{ module: l.name, title: l.connector.title, text: l.connector.instructions }] : []));

/** Every connector's paragraph, for the context view. */
export const allPrompts = () => prompts("chat").map((p) => ({ ...p, kinds: KINDS }));

/** `/m/<name>/…` */
export async function route(req: Request, url: URL): Promise<Response | undefined> {
  const m = /^\/m\/([a-z0-9-]+)(\/.*)?$/.exec(url.pathname);
  if (!m) return undefined;
  const l = loaded.get(m[1]!);
  if (!l?.connector || !l.host) return undefined;
  const rest = m[2] ?? "/";
  if (l.connector.ui && rest.startsWith("/ui/")) {
    const file = Bun.file(join(l.dir, l.connector.ui, rest.slice(4) || "index.html"));
    return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
  }
  return (await l.connector.routes?.(req, rest, url, l.host)) ?? new Response("not found", { status: 404 });
}

/** A connector's path outside `/m/`: the first mount whose prefix the path starts with. */
export async function mounted(req: Request, url: URL): Promise<Response | undefined> {
  for (const l of all()) {
    if (!l.connector?.mounts || !l.host) continue;
    for (const [prefix, handle] of Object.entries(l.connector.mounts)) if (url.pathname.startsWith(prefix)) return (await handle(req, url, l.host)) ?? new Response("not found", { status: 404 });
  }
  return undefined;
}

/** A configured connector imported here, for the command line (installed first when missing); undefined when not configured. */
async function localConnector(name: string): Promise<Connector | undefined> {
  const source = (await readConfig()).connectors[name];
  if (!source) return undefined;
  if (!isInstalled(name)) await install(name, source);
  return importConnector(dirOf(name));
}

/** Whether `pai <name> <sub>` is one the connector wants run on the laptop; `""` in `cliHere` is the bare `pai <name>`. */
export async function runsHere(name: string, sub: string | undefined) {
  const connector = await localConnector(name);
  return Boolean(connector?.cliHere?.includes(sub ?? ""));
}

/** What `pai <name> …` is handed from the CLI: the daemon's API and the terminal. */
export type CliIo = Pick<Cli, "api" | "post" | "fetch" | "out" | "json">;

/** `pai <name> …`: the connector's own command line, against the daemon's API. Undefined when no such connector is configured. */
export async function runCli(name: string, args: readonly string[], io: CliIo): Promise<number | undefined> {
  const connector = await localConnector(name);
  if (!connector) return undefined;
  if (!connector.cli) throw new Error(`${name} has no command line`);
  const dataDir = dataDirOf(name);
  mkdirSync(dataDir, { recursive: true });
  const { spin } = await import("../clients/spinner.ts");
  const { remote, isHere, sshArgs } = await import("../host/remote.ts");
  const run = async (other: string, otherArgs: readonly string[]) => (await runCli(other, otherArgs, io)) ?? 1;
  const ssh = () => {
    const r = remote();
    if (!r || isHere(r)) return undefined;
    return { args: sshArgs(r).filter((a) => a !== "-t").slice(0, -1), target: r.target };
  };
  return (await connector.cli({ ...io, name, dataDir, args, spin, run, ssh })) ?? 0;
}
