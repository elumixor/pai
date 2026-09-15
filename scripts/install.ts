#!/usr/bin/env bun
/**
 * `bun run install` — everything this machine needs, from the checkout: the web app and the
 * client bundles, the daemon as a service with `pai` on PATH (and the menu bar app on macOS),
 * and the desktop app in /Applications. `--no-app` skips the desktop build, which is the slow
 * part; `--uninstall` and `--no-menubar` are passed on to the service installer.
 *
 * The script is named `install`, which is also a lifecycle hook `bun install` runs; that
 * call is told apart by its environment and does nothing here.
 */
import { $ } from "bun";
import { join } from "node:path";
import { config } from "../src/core/config.ts";

// `bun install` below would run this script again as its lifecycle hook, with this
// process's environment; the marker is what stops that second run.
if (process.env.PAI_INSTALLING || (process.env.npm_command !== "run-script" && process.env.npm_lifecycle_event === "install")) process.exit(0);

const args = process.argv.slice(2);
const bun = process.execPath;
const env = { ...process.env, PAI_INSTALLING: "1" };
const run = (label: string, cmd: string[]) => {
  console.log(`\n▸ ${label}`);
  return $`${cmd}`.cwd(config.repo).env(env);
};

if (args.includes("--uninstall")) {
  await run("remove the service", [bun, "run", "src/clients/cli.ts", "install", "--uninstall"]);
  process.exit(0);
}

await run("dependencies", [bun, "install"]);
await run("client", [bun, "run", "build:ui"]);
await run("daemon service", [bun, "run", "src/clients/cli.ts", "install", ...args.filter((a) => a === "--no-menubar")]);
if (process.platform === "darwin" && !args.includes("--no-app"))
  await run("desktop app", [bun, "run", join("scripts", "desktop.ts"), "--install"]);
console.log("\ninstalled — `pai status` says where the daemon is");
