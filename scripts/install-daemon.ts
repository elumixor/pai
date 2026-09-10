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
const MENUBAR = "dev.elumixor.pai.menubar";
const plistPath = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const menubarPlist = join(homedir(), "Library", "LaunchAgents", `${MENUBAR}.plist`);
const repo = resolve(import.meta.dir, "..");
const logs = join(repo, "data");
const binDir = join(homedir(), ".local", "bin");
const bin = join(binDir, "pai");
const uid = process.getuid!();

if (process.argv.includes("--uninstall")) {
  await $`launchctl bootout gui/${uid}/${LABEL}`.nothrow().quiet();
  await $`launchctl bootout gui/${uid}/${MENUBAR}`.nothrow().quiet();
  rmSync(plistPath, { force: true });
  rmSync(menubarPlist, { force: true });
  rmSync(bin, { force: true });
  console.log(`removed ${plistPath}, ${menubarPlist} and ${bin}`);
  process.exit(0);
}

// process.execPath is the real bun binary; `which bun` resolves to bun's temporary
// node-shim directory under /tmp, which disappears between runs.
const bun = process.execPath;
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

/** bootout returns before the job is gone; bootstrap right after it fails with an I/O error, so retry. */
async function load(label: string, path: string) {
  await $`launchctl bootout gui/${uid}/${label}`.nothrow().quiet();
  for (let attempt = 0; ; attempt++) {
    const res = await $`launchctl bootstrap gui/${uid} ${path}`.nothrow().quiet();
    if (res.exitCode === 0) return;
    if (attempt >= 10) throw new Error(`launchctl bootstrap ${label}: ${res.stderr.toString().trim()}`);
    await Bun.sleep(500);
  }
}

await Bun.write(plistPath, plist);
await load(LABEL, plistPath);

const launcher = join(repo, "scripts", "pai");
await Bun.write(launcher, `#!/bin/sh\nexec "${bun}" run "${join(repo, "src", "cli.ts")}" "$@"\n`);
await $`chmod +x ${launcher}`;
if (existsSync(bin)) rmSync(bin);
symlinkSync(launcher, bin);

// Menu bar status app: a single Swift file, compiled here so nothing but Xcode's toolchain is needed.
const menubarBin = join(repo, "menubar", "pai-menubar");
if (!process.argv.includes("--no-menubar")) {
  await $`swiftc -O -o ${menubarBin} ${join(repo, "menubar", "main.swift")}`.quiet();
  await Bun.write(
    menubarPlist,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${MENUBAR}</string>
  <key>ProgramArguments</key><array><string>${menubarBin}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
</dict>
</plist>
`,
  );
  await load(MENUBAR, menubarPlist);
  console.log(`menu bar: ${menubarPlist}`);
}

console.log(`installed ${plistPath}`);
console.log(`cli:   ${bin} (make sure ${binDir} is on PATH)`);
console.log(`logs:  ${join(logs, "daemon.log")}`);
console.log(`stop:  launchctl bootout gui/$(id -u)/${LABEL}`);
