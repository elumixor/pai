import { kv } from "../core/db.ts";

/** The web client's choices that follow the user between browsers: its look, its keys. Its business what they hold. */

const KEY = "web_prefs";

export function all(): Readonly<Record<string, unknown>> {
  try {
    return JSON.parse(kv.get(KEY) ?? "{}") as Record<string, unknown>;
  } catch (error) {
    console.warn("[prefs] stored prefs do not parse", error);
    return {};
  }
}

export function merge(changes: Readonly<Record<string, unknown>>) {
  const next = { ...all(), ...changes };
  kv.set(KEY, JSON.stringify(next));
  return next;
}
