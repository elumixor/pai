/**
 * The menu bar app on a Mac: one Swift file compiled here, run by launchd, reading the box's
 * API for what the assistant is doing and the Claude login for the quota. `pai menubar
 * install|uninstall|status`.
 */
import { $ } from "bun";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const LABEL = "dev.elumixor.pai.menubar";
const repo = resolve(import.meta.dir, "../..");
const plist = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const binary = join(repo, "menubar", "pai-menubar");
/** Where the app reads the box's address and token: two lines, written by `install`. */
const settings = join(homedir(), ".config", "pai", "menubar");
const uid = () => process.getuid!();

export const status = () => ({ installed: existsSync(plist), settings: existsSync(settings), binary: existsSync(binary) });

/** bootout returns before the job is gone; bootstrap right after it fails with an I/O error, so retry. */
async function load() {
  await $`launchctl bootout gui/${uid()}/${LABEL}`.nothrow().quiet();
  for (let attempt = 0; ; attempt++) {
    const res = await $`launchctl bootstrap gui/${uid()} ${plist}`.nothrow().quiet();
    if (res.exitCode === 0) return;
    if (attempt >= 10) throw new Error(`launchctl bootstrap ${LABEL}: ${res.stderr.toString().trim()}`);
    await Bun.sleep(500);
  }
}

export async function install(box?: { url: string; token: string }) {
  if (process.platform !== "darwin") throw new Error("the menu bar app is for macOS");
  if (box) {
    mkdirSync(join(homedir(), ".config", "pai"), { recursive: true });
    await Bun.write(settings, `${box.url}\n${box.token}\n`);
  }
  await $`swiftc -O -o ${binary} ${join(repo, "menubar", "main.swift")}`.quiet();
  await Bun.write(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${binary}</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${join(homedir(), ".local", "bin")}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
</dict>
</plist>
`,
  );
  await load();
  return { plist, settings };
}

export async function uninstall() {
  await $`launchctl bootout gui/${uid()}/${LABEL}`.nothrow().quiet();
  rmSync(plist, { force: true });
  return { plist };
}
