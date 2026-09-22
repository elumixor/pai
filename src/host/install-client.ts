#!/usr/bin/env bun
/**
 * A laptop's pai: the `pai` command on PATH and the menu bar app. No daemon — that is the
 * box's. `--uninstall` removes both; a daemon a previous version installed here goes too.
 */
import { $ } from "bun";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import * as menubar from "./menubar.ts";
import { boxApi, isHere, remote } from "./remote.ts";

const OLD_DAEMON = "dev.elumixor.pai";
const repo = resolve(import.meta.dir, "../..");
const binDir = join(homedir(), ".local", "bin");
const bin = join(binDir, "pai");
const oldPlist = join(homedir(), "Library", "LaunchAgents", `${OLD_DAEMON}.plist`);

if (process.argv.includes("--uninstall")) {
  await menubar.uninstall();
  rmSync(bin, { force: true });
  console.log(`removed the menu bar app and ${bin}`);
  process.exit(0);
}

// A daemon from before this machine became a client: stop it, or it keeps the port and a Syncthing.
if (existsSync(oldPlist)) {
  await $`launchctl bootout gui/${process.getuid!()}/${OLD_DAEMON}`.nothrow().quiet();
  rmSync(oldPlist, { force: true });
  console.log("removed the local daemon; the box runs it");
}

mkdirSync(binDir, { recursive: true });
const launcher = join(repo, "scripts", "pai");
await Bun.write(launcher, `#!/bin/sh\nexec "${process.execPath}" run "${join(repo, "src", "clients", "cli.ts")}" "$@"\n`);
await $`chmod +x ${launcher}`;
if (existsSync(bin)) rmSync(bin);
symlinkSync(launcher, bin);
console.log(`cli:      ${bin} (make sure ${binDir} is on PATH)`);

if (process.platform === "darwin" && !process.argv.includes("--no-menubar")) {
  const box = remote();
  const api = box && !isHere(box) ? await boxApi(box).catch((err: Error) => (console.log(`menu bar: box not reachable yet (${err.message})`), undefined)) : undefined;
  const { plist } = await menubar.install(api);
  console.log(`menu bar: ${plist}`);
}
