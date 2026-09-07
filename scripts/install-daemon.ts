#!/usr/bin/env bun
/**
 * Installs pai as a launchd user agent, so it comes back after a reboot and
 * gets restarted if it crashes, and puts a `pai` command on PATH.
 * `--uninstall` removes both.
 */
import { $ } from "bun";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mkdirSync, symlinkSync, rmSync, existsSync } from "node:fs";

const LABEL = "dev.elumixor.pai";
const plistPath = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const repo = resolve(import.meta.dir, "..");
const logs = join(repo, "data");
const binDir = join(homedir(), ".local", "bin");
const bin = join(binDir, "pai");
const uid = process.getuid!();

if (process.argv.includes("--uninstall")) {
  await $`launchctl bootout gui/${uid}/${LABEL}`.nothrow().quiet();
  rmSync(plistPath, { force: true });
  rmSync(bin, { force: true });
  console.log(`removed ${plistPath} and ${bin}`);
  process.exit(0);
}

const bun = (await $`which bun`.text()).trim();
mkdirSync(logs, { recursive: true });
mkdirSync(binDir, { recursive: true });

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bun}</string>
    <string>run</string>
    <string>${join(repo, "src", "daemon.ts")}</string>
  </array>
  <key>WorkingDirectory</key><string>${repo}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${join(logs, "daemon.log")}</string>
  <key>StandardErrorPath</key><string>${join(logs, "daemon.log")}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${process.env.PATH}</string>
    <key>HOME</key><string>${homedir()}</string>
  </dict>
</dict>
</plist>
`;

await Bun.write(plistPath, plist);
await $`launchctl bootout gui/${uid}/${LABEL}`.nothrow().quiet();
await $`launchctl bootstrap gui/${uid} ${plistPath}`;

const launcher = join(repo, "scripts", "pai");
await Bun.write(launcher, `#!/bin/sh\nexec "${bun}" run "${join(repo, "src", "cli.ts")}" "$@"\n`);
await $`chmod +x ${launcher}`;
if (existsSync(bin)) rmSync(bin);
symlinkSync(launcher, bin);

console.log(`installed ${plistPath}`);
console.log(`cli:   ${bin} (make sure ${binDir} is on PATH)`);
console.log(`logs:  ${join(logs, "daemon.log")}`);
console.log(`stop:  launchctl bootout gui/$(id -u)/${LABEL}`);
