/**
 * `pai dev install [--uninstall]` (`bun run setup`): everything this machine needs from the checkout. A Mac is a
 * client of the box: the web client and `pai` on PATH, no daemon (the menu bar app is dev's: `dev menubar
 * install`). Linux is the box: the daemon as a systemd user service that comes back after a reboot (lingering)
 * and after a crash.
 */
import { $ } from "bun";
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "../core/config.ts";

const SERVICE = "pai";
/** A launchd daemon from before a Mac became a client. */
const OLD_DAEMON = "dev.elumixor.pai";
const BIN_DIR = join(homedir(), ".local", "bin");
const BIN = join(BIN_DIR, "pai");
const UNIT_DIR = join(homedir(), ".config", "systemd", "user");
const UNIT = join(UNIT_DIR, `${SERVICE}.service`);
const OLD_PLIST = join(homedir(), "Library", "LaunchAgents", `${OLD_DAEMON}.plist`);
const LOGS = join(config.repo, "data");
const mac = process.platform === "darwin";

/** `pai` on PATH: a launcher in the checkout, linked from `~/.local/bin`. process.execPath is the real bun, not a /tmp shim. */
async function linkCli() {
  mkdirSync(BIN_DIR, { recursive: true });
  const launcher = join(config.repo, "scripts", "pai");
  await Bun.write(launcher, `#!/bin/sh\nexec "${process.execPath}" run "${join(config.repo, "src", "clients", "cli.ts")}" "$@"\n`);
  await $`chmod +x ${launcher}`;
  rmSync(BIN, { force: true });
  symlinkSync(launcher, BIN);
  console.log(`cli:      ${BIN} (make sure ${BIN_DIR} is on PATH)`);
}

async function installService() {
  const path = (process.env.PATH ?? "")
    .split(":")
    .filter((p) => !p.startsWith("/tmp/bun-node-"))
    .join(":");
  mkdirSync(LOGS, { recursive: true });
  mkdirSync(UNIT_DIR, { recursive: true });
  await Bun.write(
    UNIT,
    `[Unit]
Description=pai daemon
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${process.execPath} run ${join(config.repo, "src", "daemon.ts")}
WorkingDirectory=${config.repo}
Restart=always
RestartSec=2
Environment=PATH=${path}
Environment=HOME=${homedir()}
StandardOutput=append:${join(LOGS, "daemon.log")}
StandardError=append:${join(LOGS, "daemon.log")}

[Install]
WantedBy=default.target
`,
  );
  await $`systemctl --user daemon-reload`.quiet();
  await $`systemctl --user enable --now ${SERVICE}`.quiet();
  // The user service keeps running after ssh logs out and across reboots without a login.
  await $`loginctl enable-linger ${process.env.USER ?? ""}`.nothrow().quiet();
  console.log(`service:  ${UNIT} (logs ${join(LOGS, "daemon.log")}; stop: systemctl --user stop ${SERVICE})`);
}

async function installClient() {
  // A daemon from before this machine became a client: stop it, or it keeps the port.
  if (existsSync(OLD_PLIST)) {
    await $`launchctl bootout gui/${process.getuid?.()}/${OLD_DAEMON}`.nothrow().quiet();
    rmSync(OLD_PLIST, { force: true });
    console.log("removed the local daemon; the box runs it");
  }
}

async function uninstall() {
  if (!mac) {
    await $`systemctl --user disable --now ${SERVICE}`.nothrow().quiet();
    rmSync(UNIT, { force: true });
    await $`systemctl --user daemon-reload`.nothrow().quiet();
  }
  rmSync(BIN, { force: true });
  console.log(`removed ${mac ? "" : `${UNIT} and `}${BIN}`);
}

export async function installCommand(rest: readonly string[]): Promise<number> {
  if (rest.includes("--uninstall")) {
    await uninstall();
    return 0;
  }
  const step = (label: string) => console.log(`\n▸ ${label}`);
  step("dependencies");
  await $`${process.execPath} install`.cwd(config.repo);
  step("web client");
  await $`${process.execPath} run build:web`.cwd(config.repo);
  step(mac ? "pai" : "pai + daemon service");
  await linkCli();
  if (mac) await installClient();
  else await installService();
  console.log("\ninstalled — `pai status` says what is running");
  return 0;
}
