import { homedir } from "node:os";
import { join, resolve } from "node:path";

const env = process.env;

function bool(v: string | undefined, dflt = false) {
  if (v === undefined) return dflt;
  return v === "1" || v.toLowerCase() === "true";
}

export const config = {
  /** Root that gets scanned for projects. */
  devRoot: resolve(env.BUILDER_DEV_ROOT ?? join(homedir(), "dev")),
  /** How deep under devRoot to look for git repos. */
  scanDepth: Number(env.BUILDER_SCAN_DEPTH ?? 2),

  /** Local HTTP API the CLI talks to. */
  port: Number(env.BUILDER_PORT ?? 8787),
  host: "127.0.0.1",

  dbPath: resolve(env.BUILDER_DB ?? join(import.meta.dir, "..", "data", "builder.db")),

  telegram: {
    enabled: !bool(env.BUILDER_NO_TELEGRAM),
    token: env.TELEGRAM_BOT_TOKEN ?? "",
    /** Only this chat may drive the daemon. */
    chatId: Number(env.TELEGRAM_CHAT_ID ?? 0),
  },

  /** Optional hosted dashboard that local events get pushed to. */
  dashboard: {
    url: env.BUILDER_DASHBOARD_URL ?? "",
    secret: env.BUILDER_DASHBOARD_SECRET ?? "",
  },

  session: {
    model: env.BUILDER_SESSION_MODEL ?? "sonnet",
    permissionMode: env.BUILDER_PERMISSION_MODE ?? "bypassPermissions",
    /** Kill a session process that has been idle this long (ms). Session stays resumable. */
    idleShutdownMs: Number(env.BUILDER_IDLE_SHUTDOWN_MS ?? 60 * 60 * 1000),
  },

  /** The conversational layer that decides what to do with a message. */
  agent: {
    model: env.BUILDER_AGENT_MODEL ?? "anthropic/claude-sonnet-5",
  },

  verbose: bool(env.BUILDER_VERBOSE),
};

export type Config = typeof config;
