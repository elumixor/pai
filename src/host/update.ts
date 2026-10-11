// Self-update: pull the repo, reinstall dependencies, rebuild the menu bar app, restart.
// The daemon restarts by exiting — launchd's KeepAlive brings it back on the new code.
import { $ } from "bun";
import { config } from "../core/config.ts";
import { bus } from "../core/bus.ts";
import { list } from "../domain/sessions.ts";
import { logger } from "../core/log.ts";
import { checkRelease } from "./release-check.ts";

const log = logger("update");
const MENUBAR_LABEL = "dev.elumixor.pai.menubar";

export interface UpdateStatus {
  branch: string;
  behind: number;
  dirty: boolean;
  head: string;
  /** What the daemon is following: the newest `v*` tag, or the branch's upstream. */
  target?: string;
}

export interface UpdateResult extends UpdateStatus {
  updated: boolean;
  reason?: string;
  restarting: boolean;
}

export class UpdateError extends Error {
  constructor(readonly step: string, readonly output: string) {
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

/**
 * launchd sets XPC_SERVICE_NAME to the job label; systemd sets INVOCATION_ID for any unit
 * it started. Either tells a managed daemon (which restarts on exit) from `pai daemon` run
 * by hand (which doesn't).
 */
const managedByLaunchd = () =>
  (process.env.XPC_SERVICE_NAME ?? "").startsWith("dev.elumixor.pai") || Boolean(process.env.INVOCATION_ID);

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
  const behind = target
    ? Number((await git("rev-list", "--count", `HEAD..${target}`)).stdout.toString().trim()) || 0
    : 0;
  return { branch, behind, dirty: dirty.length > 0, head, target };
}

/**
 * Pulls and rebuilds. `force` applies even with nothing to pull, which is how a local
 * edit gets picked up; without it an up-to-date or dirty checkout is left alone.
 */
export async function update(force = false): Promise<UpdateResult> {
  const s = await status();
  const skip = !force && (s.behind === 0 ? "already up to date" : undefined);
  if (skip) return { ...s, updated: false, reason: skip, restarting: false };
  if (s.dirty && s.behind > 0) return { ...s, updated: false, reason: "working tree is dirty", restarting: false };

  if (s.behind > 0 && s.target) {
    // A tag is not a branch, so it is checked out by name rather than pulled; on the
    // branch channel the target is the upstream ref and a fast-forward is enough.
    if (config.updateChannel === "tag") await run("git checkout", git("checkout", "--quiet", s.target));
    else await run("git pull", git("pull", "--ff-only"));
  }
  await run("bun install", $`${process.execPath} install`.cwd(config.repo).nothrow().quiet());
  // process.execPath, not "bun": the service's PATH is not a login shell's.
  // The client the daemon serves at /ui is the desktop app's bundle; it is built the same way.
  await run("build client", $`${process.execPath} run build:ui`.cwd(config.repo).nothrow().quiet());
  if (process.platform === "darwin") {
    await run(
      "swiftc",
      $`swiftc -O -o ${`${config.repo}/menubar/pai-menubar`} ${`${config.repo}/menubar/main.swift`}`.nothrow().quiet(),
    );
    await $`launchctl kickstart -k gui/${process.getuid!()}/${MENUBAR_LABEL}`.nothrow().quiet();
  }

  const head = (await git("rev-parse", "--short", "HEAD")).stdout.toString().trim();
  const restarting = managedByLaunchd();
  log.info(`updated to ${head}${restarting ? " — restarting" : ""}`);
  bus.emitEvent("daemon.updated", { from: s.head, to: head, restarting, at: new Date().toISOString() });
  // SIGTERM rather than exit: the daemon's own shutdown runs, so interrupted turns are
  // noted and picked up again on the other side.
  if (restarting) setTimeout(() => process.kill(process.pid, "SIGTERM"), 1200);
  return { ...s, head, updated: true, restarting };
}

/**
 * Applies new commits on their own, but only while nothing is running that a restart would
 * interrupt — and, either way, notices a release that never arrived (`checkRelease`). The notice is
 * a read, so it runs even while sessions are busy and even with auto-update off: the daemon is the
 * only observer of a release that outlives the restart the release causes.
 */
export function startAutoUpdate() {
  const tick = async () => {
    try {
      const s = await status();
      await checkRelease(s, status);
      if (!config.autoUpdate) return;
      if (list().some((x) => x.state === "busy" || x.state === "starting")) return;
      if (s.behind === 0 || s.dirty) return;
      await update();
    } catch (err) {
      log.warn(`auto-update: ${(err as Error).message}`);
    }
  };
  // One early look as well: a daemon that comes back on the wrong version should not wait out a
  // whole interval to say so.
  const first = setTimeout(tick, 2 * 60_000);
  const timer = setInterval(tick, config.autoUpdateIntervalMs);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
