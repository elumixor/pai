import { homedir } from "node:os";
import { join, resolve } from "node:path";

const env = process.env;
const repo = resolve(import.meta.dir, "../..");

function bool(v: string | undefined, dflt = false) {
  if (v === undefined) return dflt;
  return v === "1" || v.toLowerCase() === "true";
}

export const config = {
  repo,
  /** Where the assistant keeps its own files: persona (CLAUDE.md), downloads, notes. */
  workspace: resolve(env.PAI_WORKSPACE ?? join(repo, "workspace")),

  /** Root that gets scanned for coding projects. */
  devRoot: resolve(env.PAI_DEV_ROOT ?? join(homedir(), "dev")),
  scanDepth: Number(env.PAI_SCAN_DEPTH ?? 2),

  /** The HTTP API. Loopback by default; the tailnet address when other devices need it. */
  port: Number(env.PAI_PORT ?? 8787),
  host: env.PAI_BIND ?? "127.0.0.1",

  /** Shared Playwright MCP server, one per daemon. */
  browserPort: Number(env.PAI_BROWSER_PORT ?? 8931),

  dbPath: resolve(env.PAI_DB ?? join(repo, "data", "pai.db")),

  telegram: {
    enabled: !bool(env.PAI_NO_TELEGRAM),
    token: env.TELEGRAM_BOT_TOKEN ?? "",
    /** Only this chat may drive the daemon. */
    chatId: Number(env.TELEGRAM_CHAT_ID ?? 0),
  },

  /** The user's own Telegram account (MTProto), so the assistant can read and write chats as them. */
  telegramUser: {
    apiId: Number(env.TELEGRAM_API_ID ?? 0),
    apiHash: env.TELEGRAM_API_HASH ?? "",
    session: env.TELEGRAM_USER_SESSION ?? "",
  },

  /** Where this daemon is reachable on the tailnet; clients link back to it. */
  baseUrl: (env.PAI_BASE_URL ?? "").replace(/\/$/, ""),

  models: {
    main: env.PAI_MAIN_MODEL ?? "sonnet",
    task: env.PAI_TASK_MODEL ?? "sonnet",
  },

  /** Kill a session process that has been idle this long (ms). The session stays resumable. */
  idleShutdownMs: Number(env.PAI_IDLE_SHUTDOWN_MS ?? 60 * 60 * 1000),

  /** Pull and restart on new commits by itself; PAI_AUTO_UPDATE=0 to keep it manual. */
  autoUpdate: bool(env.PAI_AUTO_UPDATE, true),
  autoUpdateIntervalMs: Number(env.PAI_AUTO_UPDATE_INTERVAL_MS ?? 30 * 60 * 1000),

  /**
   * What "new version" means: "tag" follows the newest `v*` tag, so a release is a tag
   * push and untagged commits are ignored; "branch" follows the checked-out branch.
   */
  updateChannel: (env.PAI_UPDATE_CHANNEL ?? "branch") as "branch" | "tag",

  verbose: bool(env.PAI_VERBOSE),
};

export type Config = typeof config;
