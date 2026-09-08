// Self-update: pull the repo, reinstall dependencies, rebuild the menu bar app, restart.
// The daemon restarts by exiting — launchd's KeepAlive brings it back on the new code.
import { $ } from "bun";
import { config } from "./config.ts";
import { bus } from "./bus.ts";
import { list } from "./sessions.ts";
import { logger } from "./log.ts";

const log = logger("update");
const MENUBAR_LABEL = "dev.elumixor.pai.menubar";

export interface UpdateStatus {
  branch: string;
  behind: number;
  dirty: boolean;
  head: string;
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

/** launchd sets XPC_SERVICE_NAME to the job label, so this tells a managed daemon from `pai daemon`. */
const managedByLaunchd = () => (process.env.XPC_SERVICE_NAME ?? "").startsWith("dev.elumixor.pai");

export async function status(): Promise<UpdateStatus> {
  await git("fetch", "--quiet");
  const branch = (await git("rev-parse", "--abbrev-ref", "HEAD")).stdout.toString().trim();
  const behind = (await git("rev-list", "--count", "HEAD..@{u}")).stdout.toString().trim();
  const dirty = (await git("status", "--porcelain")).stdout.toString().trim();
  const head = (await git("rev-parse", "--short", "HEAD")).stdout.toString().trim();
  return { branch, behind: Number(behind) || 0, dirty: dirty.length > 0, head };
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

  if (s.behind > 0) await run("git pull", git("pull", "--ff-only"));
  await run("bun install", $`bun install`.cwd(config.repo).nothrow().quiet());
  await run(
    "swiftc",
    $`swiftc -O -o ${`${config.repo}/menubar/pai-menubar`} ${`${config.repo}/menubar/main.swift`}`.nothrow().quiet(),
  );
  await $`launchctl kickstart -k gui/${process.getuid!()}/${MENUBAR_LABEL}`.nothrow().quiet();

  const head = (await git("rev-parse", "--short", "HEAD")).stdout.toString().trim();
  const restarting = managedByLaunchd();
  log.info(`updated to ${head}${restarting ? " — restarting" : ""}`);
  bus.emitEvent("daemon.updated", { from: s.head, to: head, restarting, at: new Date().toISOString() });
  if (restarting) setTimeout(() => process.exit(0), 1200);
  return { ...s, head, updated: true, restarting };
}

/** Applies new commits on their own, but only while nothing is running that a restart would interrupt. */
export function startAutoUpdate() {
  if (!config.autoUpdate) return undefined;
  const tick = async () => {
    try {
      if (list().some((s) => s.state === "busy" || s.state === "starting")) return;
      const s = await status();
      if (s.behind === 0 || s.dirty) return;
      await update();
    } catch (err) {
      log.warn(`auto-update: ${(err as Error).message}`);
    }
  };
  const timer = setInterval(tick, config.autoUpdateIntervalMs);
  return () => clearInterval(timer);
}
