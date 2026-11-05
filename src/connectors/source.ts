/**
 * Where the connectors live on disk: `modules/` is one clone of the repository `pai.config.ts` names, or a link to a
 * checkout of it, with `connectors/<name>/` inside and the dependencies at its root. A connector's data is keyed by
 * name elsewhere (`data/modules/<name>`, kv `module:<name>:`), so nothing here ever touches it.
 */
import { $ } from "bun";
import { existsSync, lstatSync, mkdirSync, readlinkSync, renameSync, rmSync, symlinkSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { config } from "../core/config.ts";
import { logger } from "../core/log.ts";

const log = logger("connectors");

export interface PaiConfig {
  /** The connectors repository: `github:owner/repo[#ref]`, a git url, or a path (absolute, `~/…`, or relative to this repo). */
  readonly repo: string;
  /** Which of its connectors are on at the first start, and the order the clients show them. After that the user's choice (kv) decides. */
  readonly connectors: readonly string[];
}

export class ConnectorInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorInstallError";
  }
}

/** `PAI_MODULES_DIR` and `PAI_MODULES_CONFIG` point a scratch daemon at connectors of its own. */
export const modulesDir = resolve(process.env.PAI_MODULES_DIR ?? join(config.repo, "modules"));

/** `pai.config.ts`, with the keys of `pai.config.local.ts` (not committed) over it. `PAI_MODULES_CONFIG` names one file that replaces both. */
export async function readConfig(): Promise<PaiConfig> {
  const read = async (path: string): Promise<Partial<PaiConfig>> => (existsSync(path) ? ((await import(path)) as { default?: Partial<PaiConfig> }).default ?? {} : {});
  const only = process.env.PAI_MODULES_CONFIG;
  const merged = only ? await read(resolve(only)) : { ...(await read(join(config.repo, "pai.config.ts"))), ...(await read(join(config.repo, "pai.config.local.ts"))) };
  return { repo: merged.repo ?? "", connectors: merged.connectors ?? [] };
}

export const dirOf = (name: string) => join(modulesDir, "connectors", name);
/** Every connector the repository has. */
export const availableConnectors = () => (existsSync(join(modulesDir, "connectors")) ? readdirSync(join(modulesDir, "connectors")).filter((name) => existsSync(join(dirOf(name), "index.ts"))) : []);
export const isInstalled = (name: string) => existsSync(join(dirOf(name), "index.ts"));

/** `github:owner/repo#ref` as an ssh clone url and the ref; a path stays a path. */
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

const isLink = (path: string) => lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
const remove = (path: string) => rmSync(path, { recursive: true, force: true });
const git = (dir: string, ...args: string[]) => $`git -C ${dir} ${args}`.nothrow().quiet();
const oneLine = (output: { toString(): string }) => output.toString().trim().replace(/\s*\n\s*/g, " ").slice(-300);

async function install(dir: string) {
  // process.execPath, not "bun": the service's PATH is not a login shell's.
  const res = await $`${process.execPath} install`.cwd(dir).nothrow().quiet();
  if (res.exitCode !== 0) throw new ConnectorInstallError(`bun install in ${dir}: ${res.stderr.toString().trim().slice(-300)}`);
}

const installIfMissing = async (dir: string) => {
  if (!existsSync(join(dir, "node_modules", "@desk", "connector"))) await install(dir);
};

function link(target: string) {
  if (!existsSync(target)) throw new ConnectorInstallError(`${target} does not exist`);
  if (isLink(modulesDir) && readlinkSync(modulesDir) === target) return;
  remove(modulesDir);
  mkdirSync(dirname(modulesDir), { recursive: true });
  symlinkSync(target, modulesDir);
  log.info(`linked to ${target}`);
}

/** Built beside the old directory and swapped in at the end, so a failure leaves what was there alone. */
async function cloneIntoPlace(url: string, ref?: string) {
  const next = `${modulesDir}.next`;
  remove(next);
  try {
    const cloned = await $`git clone --quiet ${url} ${next}`.nothrow().quiet();
    if (cloned.exitCode !== 0) throw new ConnectorInstallError(`clone of ${url} failed: ${oneLine(cloned.stderr)}`);
    if (ref) {
      const checkout = await git(next, "checkout", "--quiet", ref);
      if (checkout.exitCode !== 0) throw new ConnectorInstallError(`no ${ref} in ${url}: ${oneLine(checkout.stderr)}`);
    }
    await install(next);
    remove(modulesDir);
    renameSync(next, modulesDir);
    log.info(`cloned ${url}`);
  } catch (err) {
    remove(next);
    throw err;
  }
}

/** Makes `modules/` what the config says: the link or the clone, with its dependencies. */
export async function ensureInstalled() {
  const { repo } = await readConfig();
  if (!repo) throw new ConnectorInstallError("no connectors repository configured");
  const source = parseSource(repo);
  if (source.kind === "path") link(source.path);
  else if (isLink(modulesDir) || !existsSync(join(modulesDir, ".git"))) await cloneIntoPlace(source.url, source.ref);
  await installIfMissing(modulesDir);
}

export interface RepositoryUpdate {
  readonly updated: boolean;
  readonly from?: string;
  readonly to?: string;
  readonly reason?: string;
}

/** Pulls the clone (onto the configured remote, so a renamed repository is followed); a link is whatever its checkout is. */
export async function update(): Promise<RepositoryUpdate> {
  if (isLink(modulesDir)) return { updated: false, reason: "linked to a checkout" };
  if (!existsSync(join(modulesDir, ".git"))) return { updated: false, reason: "not cloned yet" };
  const source = parseSource((await readConfig()).repo);
  if (source.kind === "git") {
    const current = (await git(modulesDir, "remote", "get-url", "origin")).stdout.toString().trim();
    if (current !== source.url) await git(modulesDir, "remote", "set-url", "origin", source.url);
  }
  const head = async () => (await git(modulesDir, "rev-parse", "--short", "HEAD")).stdout.toString().trim();
  const from = await head();
  const pulled = await git(modulesDir, "pull", "--ff-only", "--quiet");
  if (pulled.exitCode !== 0) return { updated: false, from, to: from, reason: oneLine(pulled.stderr) };
  const to = await head();
  if (to === from) return { updated: false, from, to };
  return install(modulesDir).then(
    () => ({ updated: true, from, to }),
    (err: Error) => ({ updated: true, from, to, reason: err.message }),
  );
}

export const updateLine = (r: RepositoryUpdate) => (r.updated ? `${r.from} to ${r.to}${r.reason ? ` (${r.reason})` : ""}` : (r.reason ?? "up to date"));
