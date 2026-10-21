import Anthropic from "@anthropic-ai/sdk";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../core/config.ts";
import { logger } from "../core/log.ts";

/**
 * Which Claude models exist, asked of the Models API rather than written down. A family name
 * (`opus`, `sonnet`, `haiku`, `fable`) resolves to the newest model of that family, so a release
 * reaches every session without a code change — Claude Code's own aliases lag behind the SDK
 * version that bundles them (`opus` was still Opus 5 a month after Opus 5.5 shipped).
 */

const log = logger("models");
const file = join(dirname(config.dbPath), "models.json");
const DAY_MS = 86_400_000;
export const FAMILIES = ["fable", "opus", "sonnet", "haiku"] as const;

export interface Model {
  readonly id: string;
  readonly name: string;
  readonly created: string;
}

let held: { at: number; models: Model[] } | undefined = (() => {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { at: number; models: Model[] }) : undefined;
  } catch {
    return undefined;
  }
})();

const familyOf = (id: string) => FAMILIES.find((f) => id.startsWith(`claude-${f}-`));

/** Every model the API lists, newest first. */
export function list(): readonly Model[] {
  return held?.models ?? [];
}

/** The newest model of each family, for a picker. */
export function latest(): Record<string, Model> {
  const out: Record<string, Model> = {};
  for (const m of list()) {
    const family = familyOf(m.id);
    if (family && !out[family]) out[family] = m;
  }
  return out;
}

/** A family name to the newest model id of that family; anything else (a full id, a dated one) as it is. */
export function resolve(model: string): string {
  return (FAMILIES as readonly string[]).includes(model) ? (latest()[model]?.id ?? model) : model;
}

async function refresh() {
  if (!config.anthropicKey) return;
  try {
    const client = new Anthropic({ apiKey: config.anthropicKey });
    const models: Model[] = [];
    for await (const m of client.models.list({ limit: 100 })) models.push({ id: m.id, name: m.display_name, created: m.created_at });
    models.sort((a, b) => b.created.localeCompare(a.created));
    held = { at: Date.now(), models };
    await Bun.write(file, JSON.stringify(held));
    log.info(`models: ${Object.values(latest()).map((m) => m.id).join(", ")}`);
  } catch (err) {
    log.warn(`models: ${(err as Error).message}`);
  }
}

/** Refreshed at start and daily; until the first answer the cached list (or the bare alias) stands. */
export function start() {
  if (!held || Date.now() - held.at > DAY_MS) void refresh();
  const timer = setInterval(() => void refresh(), DAY_MS);
  return () => clearInterval(timer);
}
