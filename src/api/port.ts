import { logger } from "../core/log.ts";

const log = logger("port");

/** The launchd daemon owns the port until it is booted out; killing it alone just makes KeepAlive bring it back. */
const DAEMON_LABEL = "dev.elumixor.pai";

const plistPath = `${process.env.HOME}/Library/LaunchAgents/${DAEMON_LABEL}.plist`;
let bootedOut = false;

function pidsOnPort(port: number): number[] {
  const res = Bun.spawnSync(["lsof", "-ti", `tcp:${port}`]);
  return new TextDecoder()
    .decode(res.stdout)
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((pid) => pid > 0 && pid !== process.pid);
}

function launchdPid(): number | undefined {
  if (process.platform !== "darwin") return undefined;
  const res = Bun.spawnSync(["launchctl", "print", `gui/${process.getuid!()}/${DAEMON_LABEL}`]);
  const pid = /^\s*pid = (\d+)/m.exec(new TextDecoder().decode(res.stdout))?.[1];
  return pid ? Number(pid) : undefined;
}

/** Whatever holds the port loses it: a stale or foreground daemon is killed, the launchd job is booted out. */
export function freePort(port: number) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const pids = pidsOnPort(port);
    if (pids.length === 0) return;
    const managed = launchdPid();
    for (const pid of pids) {
      if (pid === managed) {
        log.warn(`booting out ${DAEMON_LABEL} (pid ${pid}) to take port ${port}`);
        Bun.spawnSync(["launchctl", "bootout", `gui/${process.getuid!()}/${DAEMON_LABEL}`]);
        bootedOut = true;
      } else {
        log.warn(`killing pid ${pid} on port ${port}`);
        process.kill(pid, attempt < 6 ? "SIGTERM" : "SIGKILL");
      }
    }
    Bun.sleepSync(200);
  }
  throw new Error(`port ${port} is still in use by ${pidsOnPort(port).join(", ")}`);
}

/** Puts the launchd daemon back after a foreground run took its port. */
export function restoreDaemonJob() {
  if (!bootedOut) return;
  bootedOut = false;
  log.info(`restoring ${DAEMON_LABEL}`);
  Bun.spawnSync(["launchctl", "bootstrap", `gui/${process.getuid!()}`, plistPath]);
}

