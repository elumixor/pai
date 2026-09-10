import { config } from "./config.ts";

type Level = "debug" | "info" | "warn" | "error";

const order: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const min = config.verbose ? 0 : 1;

function emit(level: Level, scope: string, args: unknown[]) {
  if (order[level] < min) return;
  const ts = new Date().toISOString().slice(11, 23);
  const line = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}]`;
  (level === "error" ? console.error : console.log)(line, ...args);
}

export function logger(scope: string) {
  return {
    debug: (...a: unknown[]) => emit("debug", scope, a),
    info: (...a: unknown[]) => emit("info", scope, a),
    warn: (...a: unknown[]) => emit("warn", scope, a),
    error: (...a: unknown[]) => emit("error", scope, a),
  };
}
