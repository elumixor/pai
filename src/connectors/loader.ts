/**
 * The connectors `pai.config.ts` names, imported from the one clone (`source.ts`), each handed a `Host` (`host.ts`).
 * One that fails to install, load or start is reported, never fatal. pai turns their tools into one MCP server each,
 * their instructions into prompt paragraphs, serves their routes, and describes them for the clients (`GET /connectors`).
 */
import { config } from "../core/config.ts";
import { kv } from "../core/db.ts";
import { createSdkMcpServer, tool as sdkTool } from "@anthropic-ai/claude-agent-sdk";
import { broken, problemsOf, startOrder, type Cli, type Connector, type ConnectorAction, type Host, type Status, type SettingDef } from "@desk/connector";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { eventStats } from "../core/bus.ts";
import { logger } from "../core/log.ts";
import * as tasks from "../domain/tasks.ts";
import type { SessionRef } from "../domain/tools.ts";
import { dataDirOf, hostFor } from "./host.ts";
import { connectorLogs } from "./logs.ts";
import { availableConnectors, dirOf, ensureInstalled, isInstalled, readConfig } from "./source.ts";

const log = logger("connectors");

interface Loaded {
  readonly name: string;
  readonly dir: string;
  readonly connector?: Connector;
  readonly host?: Host;
  readonly icon?: string;
  readonly error?: string;
  readonly started?: boolean;
}
type Live = Loaded & { readonly connector: Connector; readonly host: Host };

/** A setting the connector does not have, or a value that does not fit it. */
export class SettingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingError";
  }
}

const loaded = new Map<string, Loaded>();
/** As `pai.config.ts` lists them: the order the clients show, not the order they start in. */
let listing: readonly string[] = [];

const ICON_TYPES: Readonly<Record<string, string>> = { ".svg": "image/svg+xml", ".png": "image/png" };

function iconOf(dir: string, connector: Connector, host: Host): string | undefined {
  const file = join(dir, connector.icon);
  const type = ICON_TYPES[extname(file)];
  if (!type || !existsSync(file)) {
    host.log.warn(`no usable icon at ${connector.icon}`);
    return undefined;
  }
  return `data:${type};base64,${readFileSync(file).toString("base64")}`;
}

/** `index.ts`'s default export, checked against the protocol. */
async function importConnector(name: string): Promise<Connector> {
  const mod = (await import(join(dirOf(name), "index.ts"))) as { default?: unknown };
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

const fail = (name: string, error: string) => {
  log.warn(`${name}: ${error}`);
  loaded.set(name, { name, dir: dirOf(name), error });
};

/** Which connectors the user has on: first the configured list, from then on what they switched. */
const CONNECTED = "connectors-connected";
const connectedNames = (): readonly string[] => JSON.parse(kv.get(CONNECTED) ?? "[]") as string[];
const isConnected = (name: string) => connectedNames().includes(name);

/** Imports every connector the repository has, installing what is missing, and starts only the connected. Called once, by the daemon. */
export async function load() {
  const { repo, connectors: first } = await readConfig();
  if (!repo) return;
  if (kv.get(CONNECTED) === undefined) kv.set(CONNECTED, JSON.stringify(first));
  try {
    await ensureInstalled();
  } catch (err) {
    for (const name of connectedNames()) fail(name, (err as Error).message);
    return;
  }
  const available = availableConnectors();
  const names = [...first.filter((name) => available.includes(name)), ...available.filter((name) => !first.includes(name))];
  listing = names;
  const imported = new Map<string, Connector>();
  for (const name of names) {
    try {
      imported.set(name, await importConnector(name));
    } catch (err) {
      fail(name, (err as Error).message);
    }
  }
  for (const name of startOrder(names, (n) => imported.get(n)?.requires ?? [])) {
    const connector = imported.get(name);
    if (!connector) continue;
    const missing = (connector.requires ?? []).filter((dep) => !loaded.get(dep)?.connector);
    if (missing.length) {
      fail(name, `requires ${missing.join(", ")}`);
      continue;
    }
    try {
      const host = hostFor(name, (other) => apiOf(name, other));
      connector.attach(host);
      loaded.set(name, { name, dir: dirOf(name), connector, host, icon: iconOf(dirOf(name), connector, host) });
    } catch (err) {
      fail(name, (err as Error).message);
    }
  }
}

export const all = () => [...loaded.values()];
const listed = () => all().sort((a, b) => listing.indexOf(a.name) - listing.indexOf(b.name));
export const get = (name: string) => loaded.get(name);
/** What a loaded connector exports as its `api`, for pai's own code; undefined when it is not loaded. */
export const api = <T>(name: string): T | undefined => (isConnected(name) ? (loaded.get(name)?.connector?.api as T | undefined) : undefined);
/** Every connector that can be connected, on or off. */
export const available = () => listing;
export const connected = isConnected;
const serverOf = (l: Loaded) => l.connector?.server ?? l.name;
const isLive = (l: Loaded | undefined): l is Live => Boolean(l?.connector && l.host);
const isEnabled = (l: Loaded) => {
  if (!isConnected(l.name)) return false;
  try {
    return l.connector?.enabled() ?? false;
  } catch (err) {
    log.warn(`${l.name}: enabled: ${(err as Error).message}`);
    return false;
  }
};
export const active = () => all().filter((l): l is Live => isLive(l) && isEnabled(l));

async function startOne(l: Live) {
  try {
    await l.connector.start();
    loaded.set(l.name, { ...l, started: true, error: undefined });
  } catch (err) {
    const error = `start failed: ${(err as Error).message}`;
    l.host.log.warn(error);
    loaded.set(l.name, { ...l, started: false, error });
  }
}

async function stopOne(l: Live) {
  try {
    await l.connector.stop();
    loaded.set(l.name, { ...l, started: false });
  } catch (err) {
    const error = `stop failed: ${(err as Error).message}`;
    l.host.log.warn(error);
    loaded.set(l.name, { ...l, started: false, error });
  }
}

export async function startAll() {
  for (const name of startOrder(listing, (n) => loaded.get(n)?.connector?.requires ?? [])) {
    const l = active().find((x) => x.name === name);
    if (l) await startOne(l);
  }
}

export async function stopAll() {
  for (const l of all()) if (isLive(l) && l.started) await stopOne(l);
}

async function restartOne(name: string, step: (l: Live) => Promise<void>) {
  const l = loaded.get(name);
  if (isLive(l)) await step(l);
}

/** Applies what changed in its settings: it stops if it was running and starts again if it is still on, and what builds on it with it. */
export async function restart(name: string) {
  if (!isLive(loaded.get(name))) return;
  const above = all().filter((l) => l.connector?.requires?.includes(name)).map((l) => l.name);
  for (const n of [...above, name]) await restartOne(n, async (l) => {
    loaded.set(n, { ...l, error: undefined });
    if (l.started) await stopOne(loaded.get(n) as Live);
  });
  for (const n of [name, ...above]) await restartOne(n, async (l) => {
    if (isEnabled(l)) await startOne(l);
  });
}

/** Turns one on, with what it builds on. Its signing in is then its own need. */
export async function connect(name: string) {
  const connector = loaded.get(name)?.connector;
  if (!connector) throw new SettingError(`no connector ${name}`);
  const wanted = [...(connector.requires ?? []), name];
  kv.set(CONNECTED, JSON.stringify([...new Set([...connectedNames(), ...wanted])]));
  for (const n of wanted) {
    const l = loaded.get(n);
    if (isLive(l) && isEnabled(l) && !l.started) await startOne(l);
  }
  await watchSignIn(true);
}

/** Turns one off, with what builds on it. Its data stays, so connecting it again picks up where it was. */
export async function disconnect(name: string) {
  const going = [name, ...all().filter((l) => l.connector?.requires?.includes(name)).map((l) => l.name)];
  for (const n of going) {
    const l = loaded.get(n);
    if (isLive(l)) {
      if (l.started) await stopOne(l);
      l.host.problems.resolve(signInTitle(l));
    }
  }
  kv.set(CONNECTED, JSON.stringify(connectedNames().filter((n) => !going.includes(n))));
}

const signInTitle = (l: Live) => `Connect ${l.connector.title}`;
const SIGN_IN_EVERY_MS = 5 * 60_000;
/** A connector still connecting after a restart is not signed out: that takes two looks in a row. */
const signedOutOnce = new Set<string>();

/** A connected connector that lost its sign-in waits on the user, with the link that fixes it. */
async function watchSignIn(now = false) {
  for (const l of active()) {
    const status = await statusOf(l);
    if (status.state === "signed_in" || !status.fix) {
      signedOutOnce.delete(l.name);
      l.host.problems.resolve(signInTitle(l));
    } else if (!now && !signedOutOnce.has(l.name)) signedOutOnce.add(l.name);
    else l.host.problems.raise({ title: signInTitle(l), detail: status.detail ?? "", action: `[${status.fix.label}](${new URL(status.fix.url, config.baseUrl).href})`, waitsOnUser: true });
  }
}

export function startSignInWatch() {
  const tick = () => void watchSignIn().catch((err: Error) => log.warn(`sign-in watch: ${err.message}`));
  const timer = setInterval(tick, SIGN_IN_EVERY_MS);
  return () => clearInterval(timer);
}

/** The status of one connector, whatever state it is in: one that failed to load or to answer is broken. */
async function statusOf(l: Loaded): Promise<Status> {
  if (l.error) return broken(l.error);
  if (!l.connector) return broken("not loaded");
  return Promise.resolve()
    .then(() => l.connector!.status())
    .catch((err: Error) => broken(err.message));
}

/** Open tasks raised by the connector, or by the observer that watches it. */
const problemsFor = (name: string) => tasks.list({ open: true }).filter((t) => t.createdBy === name || t.createdBy === `${name}-check`);

async function summaryOf(l: Loaded) {
  const [status, enabled] = [await statusOf(l), isEnabled(l)];
  return {
    name: l.name,
    kind: l.connector?.kind ?? "connector",
    title: l.connector?.title ?? l.name,
    description: l.connector?.description ?? "",
    icon: l.icon,
    server: l.connector?.tools?.length ? serverOf(l) : null,
    enabled,
    connected: isConnected(l.name),
    needsAction: Boolean(l.error) || status.state === "broken" || (enabled && (status.state !== "signed_in" || problemsFor(l.name).length > 0)),
    status,
    commands: l.connector?.commands ?? [],
    cli: Boolean(l.connector?.cli),
  };
}

/** Every configured connector as the clients list it. */
export const connectors = () => Promise.all(listed().map(summaryOf));

/** Asks a connector for something its page shows; one that throws loses that block of the page, not the page. */
function guarded<T>(l: Live, what: string, read: () => T, fallback: T): T {
  try {
    return read();
  } catch (err) {
    l.host.log.warn(`${what}: ${(err as Error).message}`);
    return fallback;
  }
}

const actionsOf = (l: Live): readonly ConnectorAction[] => guarded(l, "actions", () => l.connector.actions(), []);

function settingsOf(l: Live) {
  return l.connector.settings.map((def) => {
    const value = l.host.store.get(def.key) ?? "";
    return { ...def, value: def.secret && value ? "set" : value };
  });
}

function pageOf(l: Live) {
  const { connector } = l;
  const stats = eventStats((connector.events ?? []).map((e) => e.kind));
  return {
    tools: (connector.tools ?? []).map((t) => ({ name: t.name, description: t.description })),
    events: (connector.events ?? []).map((e) => ({ kind: e.kind, title: e.title, description: e.description, lastAt: stats.get(e.kind)?.lastAt ?? null, count: stats.get(e.kind)?.count ?? 0 })),
    actions: actionsOf(l).map((a) => ({ id: a.id, label: a.label, url: a.url ?? null, danger: Boolean(a.danger), runnable: Boolean(a.run) })),
    accounts: connector.accounts
      ? { items: guarded(l, "accounts", () => connector.accounts!.list(), []), connectPath: connector.accounts.connectPath, removePath: connector.accounts.removePath, hint: connector.accounts.hint }
      : null,
    settings: settingsOf(l),
    instructions: connector.instructions ?? null,
  };
}

const EMPTY_PAGE: ReturnType<typeof pageOf> = { tools: [], events: [], actions: [], accounts: null, settings: [], instructions: null };

/** One connector with everything its page shows; undefined when it is not configured. */
export async function detail(name: string) {
  const l = loaded.get(name);
  if (!l) return undefined;
  return {
    ...(await summaryOf(l)),
    ...(isLive(l) ? pageOf(l) : EMPTY_PAGE),
    problems: problemsFor(name).map((t) => ({ title: t.title, detail: t.notes ?? "", action: t.nextAction || null })),
    error: l.error ?? null,
    logs: connectorLogs.of(name),
  };
}

/** An empty value clears a setting, which always fits. */
function checkSetting(connector: string, def: SettingDef | undefined, key: string, value: string) {
  if (!def) throw new SettingError(`${key} is not a setting of ${connector}`);
  if (!value) return;
  if (def.type === "number" && !(Number(value) > 0)) throw new SettingError(`${def.label} takes a positive number`);
  if (def.type === "select" && !def.options?.includes(value)) throw new SettingError(`${def.label} takes one of: ${def.options?.join(", ")}`);
}

/** Writes settings into the connector's store, all or nothing; an empty value deletes. The caller applies them with `restart`. */
export function writeSettings(name: string, changes: Readonly<Record<string, unknown>>) {
  const l = loaded.get(name);
  const defs = isLive(l) ? l.connector.settings : [];
  const values = Object.entries(changes).map(([key, value]) => [key, String(value ?? "")] as const);
  for (const [key, value] of values) checkSetting(name, defs.find((d) => d.key === key), key, value);
  if (isLive(l)) for (const [key, value] of values) l.host.store.set(key, value || undefined);
}

export function action(name: string, id: string) {
  const l = loaded.get(name);
  return isLive(l) ? actionsOf(l).find((a) => a.id === id) : undefined;
}

/** Every event the loaded connectors say they emit, for the routine picker. */
export const connectorEvents = () =>
  listed().flatMap((l) => (l.connector?.events ?? []).map((e) => ({ kind: e.kind, title: e.title, description: e.description, source: l.name, sourceTitle: l.connector!.title, icon: l.icon })));

/** Which connector serves an MCP server, for telling its tools from pai's own and the account's. */
export const serverConnectors = (): ReadonlyMap<string, string> => new Map(all().flatMap((l) => (l.connector?.tools?.length ? [[serverOf(l), l.name] as const] : [])));

/** The MCP servers connectors add to a session: one per connector with tools, the caller passed to each tool as its agent. */
export function mcpServers(ref: SessionRef) {
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
export const prompts = () => active().flatMap((l) => (l.connector.instructions ? [{ connector: l.name, title: l.connector.title, text: l.connector.instructions }] : []));

/** `/m/<name>/…` */
export async function route(req: Request, url: URL): Promise<Response | undefined> {
  const m = /^\/m\/([a-z0-9-]+)(\/.*)?$/.exec(url.pathname);
  if (!m) return undefined;
  const l = loaded.get(m[1]!);
  if (!l?.connector) return undefined;
  const rest = m[2] ?? "/";
  if (l.connector.ui && rest.startsWith("/ui/")) {
    const file = Bun.file(join(l.dir, l.connector.ui, rest.slice(4) || "index.html"));
    return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
  }
  return (await l.connector.routes?.(req, rest, url)) ?? new Response("not found", { status: 404 });
}

/** A connector's path outside `/m/`: the first mount whose prefix the path starts with. */
export async function mounted(req: Request, url: URL): Promise<Response | undefined> {
  for (const l of all()) {
    if (!l.connector?.mounts) continue;
    for (const [prefix, handle] of Object.entries(l.connector.mounts)) if (url.pathname.startsWith(prefix)) return (await handle(req, url)) ?? new Response("not found", { status: 404 });
  }
  return undefined;
}

/** A connector imported here, for the command line (the repository cloned first when missing); undefined when there is no such connector. */
async function localConnector(name: string): Promise<Connector | undefined> {
  if (!availableConnectors().length) await ensureInstalled();
  return isInstalled(name) ? importConnector(name) : undefined;
}

/** Whether `pai <name> <sub>` is one the connector wants run on the laptop; `""` in `cliHere` is the bare `pai <name>`. */
export async function runsHere(name: string, sub: string | undefined) {
  const connector = await localConnector(name);
  return Boolean(connector?.cliHere?.includes(sub ?? ""));
}

/** What `pai <name> …` is handed from the CLI: the daemon's API and the terminal. */
export type CliIo = Pick<Cli, "api" | "post" | "fetch" | "out" | "json">;

/** `pai <name> …`: the connector's own command line, against the daemon's API, with no host. Undefined when no such connector is configured. */
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
