import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The zsh completion, sourced from `.zshrc`: `installed`, `updated` (the script changed) or `current`. */
export async function installCompletion(script: string) {
  const dir = join(homedir(), ".config", "pai");
  const file = join(dir, "completion.zsh");
  const rc = join(homedir(), ".zshrc");
  const line = `source ${file.replace(homedir(), "~")}`;
  const sourced = existsSync(rc) && readFileSync(rc, "utf8").includes(line);
  const same = existsSync(file) && readFileSync(file, "utf8") === script;
  if (!same) {
    mkdirSync(dir, { recursive: true });
    await Bun.write(file, script);
  }
  if (!sourced) appendFileSync(rc, `\n# pai completion\n${line}\n`);
  const status: "installed" | "updated" | "current" = !sourced ? "installed" : same ? "current" : "updated";
  return { status, file, rc };
}
