import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../core/config.ts";
import { day, zoned } from "../core/time.ts";

/**
 * The daily journal: `workspace/journal/YYYY-MM-DD.md`, what happened that day. pai writes the
 * day into it when its session rotates; the daemon adds one-liners as things close. Yesterday's
 * is part of the briefing a fresh session starts from.
 */

export const dir = () => join(config.workspace, "journal");
export const path = (d: string) => join(dir(), `${d}.md`);

/**
 * The day a moment belongs to. Before the rotation hour it is still yesterday: the night's
 * work is the evening's, and the 04:00 rotation writes up the day that just ended.
 */
export function logicalDay(at: number = Date.now()) {
  return zoned(at).hour < config.rotateHour ? day(at - 24 * 3600 * 1000) : day(at);
}

export function read(d: string): string {
  return existsSync(path(d)) ? readFileSync(path(d), "utf8") : "";
}

/** One line under the day's "Log" heading, with the time. */
export function append(line: string, at: number = Date.now()) {
  mkdirSync(dir(), { recursive: true });
  const d = logicalDay(at);
  const file = path(d);
  const z = zoned(at);
  const head = existsSync(file) ? "" : `# ${d}\n\n`;
  appendFileSync(file, `${head}- ${String(z.hour).padStart(2, "0")}:${String(z.minute).padStart(2, "0")} ${line.replace(/\s+/g, " ").trim()}\n`);
}

/** The day before `d`. */
export function previous(d: string) {
  const t = Date.parse(`${d}T12:00:00Z`) - 24 * 3600 * 1000;
  return new Date(t).toISOString().slice(0, 10);
}
