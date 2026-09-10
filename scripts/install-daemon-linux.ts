#!/usr/bin/env bun
/**
 * Installs pai as a systemd --user service on Linux (the VPS case), the systemd analogue
 * of `install-daemon.ts`: comes back after reboot (via lingering) and after a crash, and
 * puts a `pai` command on PATH. No menu bar app — there's no desktop to put it in.
 * `--uninstall` removes it.
 */
import { $ } from "bun";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mkdirSync, symlinkSync, rmSync, existsSync } from "node:fs";

const LABEL = "pai";
const unitDir = join(homedir(), ".config", "systemd", "user");
const unitPath = join(unitDir, `${LABEL}.service`);
const repo = resolve(import.meta.dir, "..");
const logs = join(repo, "data");
const binDir = join(homedir(), ".local", "bin");
const bin = join(binDir, "pai");

if (process.argv.includes("--uninstall")) {
  await $`systemctl --user disable --now ${LABEL}`.nothrow().quiet();
  rmSync(unitPath, { force: true });
  await $`systemctl --user daemon-reload`.nothrow().quiet();
  rmSync(bin, { force: true });
  console.log(`removed ${unitPath} and ${bin}`);
  process.exit(0);
}

// process.execPath is the real bun binary; `which bun` resolves to bun's temporary
// node-shim directory under /tmp, which disappears between runs.
const bun = process.execPath;
const path = (process.env.PATH ?? "")
  .split(":")
  .filter((p) => !p.startsWith("/tmp/bun-node-"))
  .join(":");
mkdirSync(logs, { recursive: true });
mkdirSync(binDir, { recursive: true });
mkdirSync(unitDir, { recursive: true });

const unit = `[Unit]
Description=pai daemon
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${bun} run ${join(repo, "src", "daemon.ts")}
WorkingDirectory=${repo}
Restart=always
RestartSec=2
Environment=PATH=${path}
Environment=HOME=${homedir()}
StandardOutput=append:${join(logs, "daemon.log")}
StandardError=append:${join(logs, "daemon.log")}

[Install]
WantedBy=default.target
`;

await Bun.write(unitPath, unit);
await $`systemctl --user daemon-reload`.quiet();
await $`systemctl --user enable --now ${LABEL}`.quiet();

// Lets the user service keep running after SSH logs out / across reboots without a login.
await $`loginctl enable-linger ${process.env.USER}`.nothrow().quiet();

const launcher = join(repo, "scripts", "pai");
await Bun.write(launcher, `#!/bin/sh\nexec "${bun}" run "${join(repo, "src", "cli.ts")}" "$@"\n`);
await $`chmod +x ${launcher}`;
if (existsSync(bin)) rmSync(bin);
symlinkSync(launcher, bin);

console.log(`installed ${unitPath}`);
console.log(`cli:   ${bin} (make sure ${binDir} is on PATH)`);
console.log(`logs:  ${join(logs, "daemon.log")}`);
console.log(`stop:  systemctl --user stop ${LABEL}`);
