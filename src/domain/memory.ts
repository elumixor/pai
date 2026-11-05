import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../core/config.ts";

const file = () => join(config.workspace, "MEMORY.md");

/**
 * The one way a session changes long-term memory. Without `find` the text is added at the end; with it, that passage is
 * replaced, and an empty text removes it. A passage must match exactly once, so a vague `find` cannot rewrite the wrong
 * fact.
 */
export function editMemory({ find, text }: { find?: string; text: string }) {
  const before = existsSync(file()) ? readFileSync(file(), "utf8") : "";
  if (!find) {
    if (!text.trim()) throw new Error("Nothing to add");
    writeFileSync(file(), `${before.trimEnd()}${before.trim() ? "\n" : ""}${text.trim()}\n`);
    return;
  }
  const times = before.split(find).length - 1;
  if (times !== 1) throw new Error(times ? `That passage appears ${times} times: give more of it` : "That passage is not in memory");
  writeFileSync(file(), before.replace(find, () => text).replace(/\n{3,}/g, "\n\n"));
}
