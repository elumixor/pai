#!/usr/bin/env bun
/**
 * `bun run install` — everything this machine needs, from the checkout: the web client, the
 * daemon as a service with `pai` on PATH (and the menu bar app on macOS). `--uninstall` and
 * `--no-menubar` are passed on to the service installer.
 *
 * The script is named `install`, which is also a lifecycle hook `bun install` runs; that
 * call is told apart by its environment and does nothing here.
 */
import { $ } from "bun";
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
  await run("remove", [bun, "run", process.platform === "darwin" ? "src/host/install-client.ts" : "src/host/install-daemon-linux.ts", "--uninstall"]);
  process.exit(0);
}

await run("dependencies", [bun, "install"]);
await run("web client", [bun, "run", "build:web"]);
// A Mac is a client of the box: the command and the menu bar app. Linux is the box.
if (process.platform === "darwin") {
  await run("pai + menu bar", [bun, "run", "src/host/install-client.ts", ...args.filter((a) => a === "--no-menubar")]);
} else {
  await run("daemon service", [bun, "run", "src/host/install-daemon-linux.ts"]);
}
console.log("\ninstalled — `pai status` says what is running");
