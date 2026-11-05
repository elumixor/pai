import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../core/config.ts";

const file = () => join(config.workspace, "MEMORY.md");

/**
 * Memory with nothing in it yet: the note is what starts the first talk, and it says to take itself out. A pai that
 * knows nothing is always told how to fix that, so there is no empty state to get stuck in.
 */
export const BLANK_MEMORY = `# Profile

Nothing is known about the user yet. Get to know them in a natural chat, not a form: their life sphere by sphere (work and projects, money, health, family and friends, home, learning, what they do for fun, what they want from the next year or two), one or two questions at a time, in their language, following what they say and looking up what you can (Keep, their calendar). Write what you learn here with edit_memory as you go. Once you know them well enough to help, remove this note.
`;

const read = () => (existsSync(file()) ? readFileSync(file(), "utf8") : "");
const blank = (text: string) => ["", "# Profile", BLANK_MEMORY.trim()].includes(text.trim());

export const isBlank = () => blank(read());

/** Memory cleared, by anyone: back to the note, so the next talk starts from it. */
export function ensureMemory() {
  const text = read();
  if (blank(text) && text !== BLANK_MEMORY) writeFileSync(file(), BLANK_MEMORY);
}

export const clearMemory = () => writeFileSync(file(), BLANK_MEMORY);

/**
 * The one way a session changes long-term memory. Without `find` the text is added at the end; with it, that passage is
 * replaced, and an empty text removes it. A passage must match exactly once, so a vague `find` cannot rewrite the wrong
 * fact.
 */
export function editMemory({ find, text }: { find?: string; text: string }) {
  const before = read();
  if (!find) {
    if (!text.trim()) throw new Error("Nothing to add");
    writeFileSync(file(), `${before.trimEnd()}${before.trim() ? "\n" : ""}${text.trim()}\n`);
    return;
  }
  const times = before.split(find).length - 1;
  if (times !== 1) throw new Error(times ? `That passage appears ${times} times: give more of it` : "That passage is not in memory");
  writeFileSync(file(), before.replace(find, () => text).replace(/\n{3,}/g, "\n\n"));
}
