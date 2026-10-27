/**
 * Self-update, kept in core on purpose: whatever else fails to load, a box can always be brought to a new
 * version — `POST /update` (what CI calls) and the auto-update tick both land here. Fetch, check out the tag (or
 * fast-forward the branch), install, build the web client, pull every module clone, restart. The daemon restarts
 * by exiting: the service manager brings it back on the new code.
 */
import { $ } from "bun";
import { config } from "../core/config.ts";
import { bus } from "../core/bus.ts";
import { logger } from "../core/log.ts";
import * as external from "../modules/external.ts";
import { list } from "./sessions.ts";

const log = logger("update");

export interface UpdateStatus {
  readonly branch: string;
  readonly behind: number;
  readonly dirty: boolean;
  readonly head: string;
  /** What the daemon is following: the newest `v*` tag, or the branch's upstream. */
  readonly target?: string;
}

export interface UpdateResult extends UpdateStatus {
  readonly updated: boolean;
  readonly reason?: string;
  readonly restarting: boolean;
  /** What each module clone did: moved, or why not. */
  readonly modules?: Readonly<Record<string, string>>;
}

export class UpdateError extends Error {
  constructor(
    readonly step: string,
    readonly output: string,
  ) {
    super(`update failed at ${step}: ${output.slice(0, 400)}`);
    this.name = "UpdateError";
  }
}

const git = (...args: string[]) => $`git ${args}`.cwd(config.repo).nothrow().quiet();

async function run(step: string, cmd: ReturnType<typeof git>) {
  const res = await cmd;
  if (res.exitCode !== 0) throw new UpdateError(step, `${res.stderr.toString()}${res.stdout.toString()}`.trim());
  return res.stdout.toString().trim();
}

/** systemd sets INVOCATION_ID for any unit it started, launchd the job label: either restarts the daemon when it exits. */
const managed = () => (process.env.XPC_SERVICE_NAME ?? "").startsWith("dev.elumixor.pai") || Boolean(process.env.INVOCATION_ID);

/** The newest `v*` tag by version order, or undefined when the repo has none. */
async function latestTag() {
  const out = (await git("tag", "--list", "v*", "--sort=-v:refname")).stdout.toString().trim();
  return out.split("\n")[0]?.trim() || undefined;
}

export async function status(): Promise<UpdateStatus> {
  await git("fetch", "--quiet", "--tags", "--force");
  const branch = (await git("rev-parse", "--abbrev-ref", "HEAD")).stdout.toString().trim();
  const dirty = (await git("status", "--porcelain")).stdout.toString().trim();
  const head = (await git("rev-parse", "--short", "HEAD")).stdout.toString().trim();
  const target = config.updateChannel === "tag" ? await latestTag() : "@{u}";
  const behind = target ? Number((await git("rev-list", "--count", `HEAD..${target}`)).stdout.toString().trim()) || 0 : 0;
  return { branch, behind, dirty: dirty.length > 0, head, target };
}

/** Every module clone pulled: a module broken upstream is healed by the same update that brings pai. */
async function pullModules() {
  const out: Record<string, string> = {};
  for (const m of external.all()) {
    const r = await external.update(m.name).catch((err: Error) => ({ updated: false, reason: err.message }));
    out[m.name] = r.updated && "to" in r ? `${r.from} → ${r.to}` : (("reason" in r ? r.reason : undefined) ?? "up to date");
  }
  return out;
}

/**
 * Pulls and rebuilds. `force` applies even with nothing to pull, which is how a local edit or a module's new
 * commit gets picked up; without it an up-to-date or dirty checkout is left alone.
 */
export async function update(force = false): Promise<UpdateResult> {
  const s = await status();
  if (!force && s.behind === 0) return { ...s, updated: false, reason: "already up to date", restarting: false };
  if (s.dirty && s.behind > 0) return { ...s, updated: false, reason: "working tree is dirty", restarting: false };

  if (s.behind > 0 && s.target) {
    // A tag is not a branch, so it is checked out by name rather than pulled.
    if (config.updateChannel === "tag") await run("git checkout", git("checkout", "--quiet", s.target));
    else await run("git pull", git("pull", "--ff-only"));
  }
  // process.execPath, not "bun": the service's PATH is not a login shell's.
  await run("bun install", $`${process.execPath} install`.cwd(config.repo).nothrow().quiet());
  await run("build client", $`${process.execPath} run build:web`.cwd(config.repo).nothrow().quiet());
  const modules = await pullModules();

  const head = (await git("rev-parse", "--short", "HEAD")).stdout.toString().trim();
  const restarting = managed();
  log.info(`updated to ${head}${restarting ? " — restarting" : ""}`);
  bus.emitEvent("daemon.updated", { from: s.head, to: head, restarting, modules, at: new Date().toISOString() });
  // SIGTERM rather than exit: the daemon's own shutdown runs, so interrupted turns are noted and picked up again.
  if (restarting) setTimeout(() => process.kill(process.pid, "SIGTERM"), 1200);
  return { ...s, head, updated: true, restarting, modules };
}

const FIRST_LOOK_MS = 2 * 60_000;

/** Applies new commits on its own, but only while nothing is running that a restart would interrupt. */
export function startAutoUpdate() {
  if (!config.autoUpdate) return () => {};
  const tick = async () => {
    try {
      if (list().some((x) => x.state === "busy" || x.state === "starting")) return;
      const s = await status();
      if (s.behind === 0 || s.dirty) return;
      await update();
    } catch (err) {
      log.warn(`auto-update: ${(err as Error).message}`);
    }
  };
  // One early look as well: a daemon that comes back on the wrong version should not wait out a whole interval.
  const first = setTimeout(tick, FIRST_LOOK_MS);
  const timer = setInterval(tick, config.autoUpdateIntervalMs);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
