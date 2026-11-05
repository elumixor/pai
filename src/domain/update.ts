/**
 * Self-update, kept in core on purpose: whatever else fails to load, a box can always be brought to a new
 * version — `POST /update` (what CI calls) and the auto-update tick both land here. Fetch, check out the tag (or
 * fast-forward the branch), install, build the web client, pull the connectors, restart. The daemon restarts
 * by exiting: the service manager brings it back on the new code.
 */
import { $ } from "bun";
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "../core/config.ts";
import { bus } from "../core/bus.ts";
import { logger } from "../core/log.ts";
import { update as pullConnectors, updateLine } from "../connectors/source.ts";
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
  /** What the connectors clone did: moved, or why not. */
  readonly connectors?: string;
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

/** The box's own `bun install` rewrites these (another bun version words a git dependency differently), which is no local edit: left counting as one, it refuses every update after. */
const LOCKFILES = ["bun.lock", "apps/web/bun.lock"];

async function run(step: string, cmd: ReturnType<typeof git>) {
  const res = await cmd;
  if (res.exitCode !== 0) throw new UpdateError(step, `${res.stderr.toString()}${res.stdout.toString()}`.trim());
  return res.stdout.toString().trim();
}

/** systemd sets INVOCATION_ID for any unit it started, launchd the job label: either restarts the daemon when it exits. */
const managed = () => (process.env.XPC_SERVICE_NAME ?? "").startsWith("dev.elumixor.pai") || Boolean(process.env.INVOCATION_ID);

const dataFile = (name: string) => join(config.repo, "data", name);
/** Tags `scripts/rollback.sh` came back from: never installed again, or the tick would undo the rollback. */
const badVersions = () => (existsSync(dataFile("bad-versions")) ? readFileSync(dataFile("bad-versions"), "utf8").split("\n").filter(Boolean) : []);
/** Set while an update is under way: a tree checked out but not built is behind nothing and still has to finish. */
const UNFINISHED = "update-unfinished";

/** The newest `v*` tag by version order that has not crash-looped, or undefined when there is none. */
async function latestTag() {
  const out = (await git("tag", "--list", "v*", "--sort=-v:refname")).stdout.toString().trim();
  const bad = badVersions();
  return out.split("\n").map((tag) => tag.trim()).find((tag) => tag && !bad.includes(tag));
}

export async function status(): Promise<UpdateStatus> {
  await git("fetch", "--quiet", "--tags", "--force");
  const branch = (await git("rev-parse", "--abbrev-ref", "HEAD")).stdout.toString().trim();
  const dirty = (await git("status", "--porcelain", "--", ".", ...LOCKFILES.map((f) => `:!${f}`))).stdout.toString().trim();
  const head = (await git("rev-parse", "--short", "HEAD")).stdout.toString().trim();
  const target = config.updateChannel === "tag" ? await latestTag() : "@{u}";
  const behind = target ? Number((await git("rev-list", "--count", `HEAD..${target}`)).stdout.toString().trim()) || 0 : 0;
  return { branch, behind, dirty: dirty.length > 0, head, target };
}

/**
 * Pulls and rebuilds. `force` applies even with nothing to pull, which is how a local edit or a connector's new
 * commit gets picked up; without it an up-to-date or dirty checkout is left alone.
 */
export async function update(force = false): Promise<UpdateResult> {
  const s = await status();
  const unfinished = existsSync(dataFile(UNFINISHED));
  if (!force && s.behind === 0 && !unfinished) return { ...s, updated: false, reason: "already up to date", restarting: false };
  if (s.dirty && s.behind > 0) return { ...s, updated: false, reason: "working tree is dirty", restarting: false };

  writeFileSync(dataFile(UNFINISHED), s.head);
  if (s.behind > 0 && s.target) {
    await run("restore lockfiles", git("checkout", "--quiet", "--", ...LOCKFILES));
    // A tag is not a branch, so it is checked out by name rather than pulled.
    if (config.updateChannel === "tag") await run("git checkout", git("checkout", "--quiet", s.target));
    else await run("git pull", git("pull", "--ff-only"));
  }
  // process.execPath, not "bun": the service's PATH is not a login shell's.
  await run("bun install", $`${process.execPath} install`.cwd(config.repo).nothrow().quiet());
  await run("build client", $`${process.execPath} run build:web`.cwd(config.repo).nothrow().quiet());
  // A connector broken upstream is healed by the same update that brings pai.
  const connectors = updateLine(await pullConnectors());
  rmSync(dataFile(UNFINISHED), { force: true });

  const head = (await git("rev-parse", "--short", "HEAD")).stdout.toString().trim();
  const restarting = managed();
  log.info(`updated to ${head}${restarting ? " — restarting" : ""}`);
  bus.emitEvent("daemon.updated", { from: s.head, to: head, restarting, connectors, at: new Date().toISOString() });
  // SIGTERM rather than exit: the daemon's own shutdown runs, so interrupted turns are noted and picked up again.
  if (restarting) setTimeout(() => process.kill(process.pid, "SIGTERM"), 1200);
  return { ...s, head, updated: true, restarting, connectors };
}

const FIRST_LOOK_MS = 2 * 60_000;

/** Applies new commits on its own, but only while nothing is running that a restart would interrupt. */
export function startAutoUpdate() {
  if (!config.autoUpdate) return () => {};
  const tick = async () => {
    try {
      if (list().some((x) => x.state === "busy" || x.state === "starting")) return;
      const s = await status();
      if ((s.behind === 0 && !existsSync(dataFile(UNFINISHED))) || s.dirty) return;
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

/** Long enough that a crash after start counts against this version; the service's restart limit covers it. */
const PROVEN_AFTER_MS = 60_000;
const RESCUE = "pai-rollback";

const revision = (dir: string) => {
  const out = Bun.spawnSync(["git", "-C", dir, "rev-parse", "HEAD"]);
  return out.exitCode === 0 ? out.stdout.toString().trim() : "";
};

/**
 * What `scripts/rollback.sh` goes back to. The revisions are read at process start, because an update can move HEAD
 * under a running daemon and that new tag has proved nothing yet. The rescue script is refreshed only from a version
 * that stayed up.
 */
export function startProving() {
  if (!managed()) return () => {};
  const revisions = `${revision(config.repo)}\n${revision(join(config.repo, "modules"))}\n`;
  const timer = setTimeout(() => {
    try {
      writeFileSync(dataFile("last-good"), revisions);
      if (process.platform === "linux") copyFileSync(join(config.repo, "scripts", "rollback.sh"), join(homedir(), ".local", "bin", RESCUE));
    } catch (err) {
      log.warn(`could not record the last good version: ${(err as Error).message}`);
    }
  }, PROVEN_AFTER_MS);
  return () => clearTimeout(timer);
}
