#!/usr/bin/env bun
/**
 * Installs builder as a launchd user agent, so it comes back after a reboot and
 * gets restarted if it crashes. Run `bun scripts/install-daemon.ts --uninstall`
 * to remove it.
 */
import { $ } from "bun";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";

const LABEL = "dev.elumixor.builder";
const plistPath = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const repo = resolve(import.meta.dir, "..");
const logs = join(repo, "data");

if (process.argv.includes("--uninstall")) {
  await $`launchctl bootout gui/${process.getuid!()}/${LABEL}`.nothrow().quiet();
  await $`rm -f ${plistPath}`;
  console.log(`removed ${plistPath}`);
  process.exit(0);
}

const bun = (await $`which bun`.text()).trim();
mkdirSync(logs, { recursive: true });

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
  </dict>
</dict>
</plist>
`;

await Bun.write(plistPath, plist);
await $`launchctl bootout gui/${process.getuid!()}/${LABEL}`.nothrow().quiet();
await $`launchctl bootstrap gui/${process.getuid!()} ${plistPath}`;
console.log(`installed ${plistPath}`);
console.log(`logs: ${join(logs, "daemon.log")}`);
console.log(`stop:  launchctl bootout gui/$(id -u)/${LABEL}`);
