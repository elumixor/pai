/**
 * This checkout as a laptop's `pai`: the CLI, the menu bar app, the desktop app. Updating it
 * is a pull and a rebuild of what is installed here; the daemon is on the box and updates
 * itself.
 */
import { $ } from "bun";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "../core/config.ts";

const git = (...args: string[]) => $`git ${args}`.cwd(config.repo).nothrow().quiet();

/** The zsh completion, sourced from `.zshrc`; regenerated on every client update. */
export async function installCompletion(script: string) {
  const dir = join(homedir(), ".config", "pai");
  const file = join(dir, "completion.zsh");
  mkdirSync(dir, { recursive: true });
  await Bun.write(file, script);
  const rc = join(homedir(), ".zshrc");
  const line = `source ${file.replace(homedir(), "~")}`;
  const current = existsSync(rc) ? readFileSync(rc, "utf8") : "";
  if (!current.includes(line)) appendFileSync(rc, `\n# pai completion\n${line}\n`);
  return { file, rc };
}

export async function update() {
  const before = (await git("rev-parse", "--short", "HEAD")).stdout.toString().trim();
  const dirty = (await git("status", "--porcelain")).stdout.toString().trim().length > 0;
  if (!dirty) await git("pull", "--ff-only", "--quiet");
  const head = (await git("rev-parse", "--short", "HEAD")).stdout.toString().trim();
  const updated = head !== before;
  if (updated) {
    await $`${process.execPath} install`.cwd(config.repo).quiet();
    if (process.platform === "darwin" && existsSync(join(homedir(), "Library", "LaunchAgents", "dev.elumixor.pai.menubar.plist")))
      await import("./menubar.ts").then((m) => m.install());
  }
  return { head, updated, dirty };
}
