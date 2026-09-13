import { existsSync, readFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "../..");

// Bun only auto-loads .env from the current directory, and the CLI is run from anywhere.
// Reading the repository's own file keeps one source of settings for every entry point.
const envFile = join(repo, ".env");
for (const line of existsSync(envFile) ? readFileSync(envFile, "utf8").split("\n") : []) {
  const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
  if (!match?.[1] || process.env[match[1]] !== undefined) continue;
  process.env[match[1]] = (match[2] ?? "").replace(/^["']|["']$/g, "");
}

const env = process.env;

function bool(v: string | undefined, dflt = false) {
  if (v === undefined) return dflt;
  return v === "1" || v.toLowerCase() === "true";
}

/**
 * The Tailscale address of this machine, if it is on a tailnet (100.64.0.0/10). Binding
 * there rather than to loopback is what makes the API, the dashboard and the editor reachable
 * from other devices without a tunnel — and still not reachable from the internet.
 */
function tailnetAddress() {
  for (const addresses of Object.values(networkInterfaces()))
    for (const address of addresses ?? [])
      if (address.family === "IPv4" && /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address.address))
        return address.address;
  return undefined;
}

/** Settings the dashboard may change, written back to `data/config.json` and merged over the environment. */
const overridesPath = resolve(env.PAI_CONFIG ?? join(repo, "data", "config.json"));
const overrides: Record<string, string> = existsSync(overridesPath)
  ? (JSON.parse(readFileSync(overridesPath, "utf8")) as Record<string, string>)
  : {};
const setting = (name: string) => overrides[name] ?? env[name];

export const config = {
  overridesPath,
  repo,
  /** Where the assistant keeps its own files: persona (CLAUDE.md), downloads, notes. */
  workspace: resolve(env.PAI_WORKSPACE ?? join(repo, "workspace")),

  /** Root that gets scanned for coding projects. */
  devRoot: resolve(env.PAI_DEV_ROOT ?? join(homedir(), "dev")),
  scanDepth: Number(env.PAI_SCAN_DEPTH ?? 2),

  /** The HTTP API. Loopback by default; the tailnet address when other devices need it. */
  port: Number(env.PAI_PORT ?? 8787),
  host: setting("PAI_BIND") ?? tailnetAddress() ?? "127.0.0.1",

  /**
   * The browser editor (code-server with the pai extension), started and supervised by the
   * daemon on the same address as the API. PAI_NO_EDITOR=1 turns it off.
   */
  editor: {
    enabled: !bool(setting("PAI_NO_EDITOR")),
    port: Number(setting("PAI_EDITOR_PORT") ?? 8788),
    host: setting("PAI_EDITOR_BIND") ?? setting("PAI_BIND") ?? tailnetAddress() ?? "127.0.0.1",
    password: env.PAI_EDITOR_PASSWORD ?? "",
  },

  /** Shared Playwright MCP server, one per daemon. */
  browserPort: Number(env.PAI_BROWSER_PORT ?? 8931),

  dbPath: resolve(env.PAI_DB ?? join(repo, "data", "pai.db")),

  /** Project-scoped Hetzner Cloud API token, read-only use: pricing the host actually costs. */
  hcloudToken: env.HCLOUD_TOKEN ?? "",

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
  baseUrl: (setting("PAI_BASE_URL") ?? "").replace(/\/$/, ""),

  models: {
    main: setting("PAI_MAIN_MODEL") ?? "sonnet",
    task: setting("PAI_TASK_MODEL") ?? "sonnet",
  },

  /** Kill a session process that has been idle this long (ms). The session stays resumable. */
  idleShutdownMs: Number(setting("PAI_IDLE_SHUTDOWN_MS") ?? 60 * 60 * 1000),

  /** Pull and restart on new commits by itself; PAI_AUTO_UPDATE=0 to keep it manual. */
  autoUpdate: bool(setting("PAI_AUTO_UPDATE"), true),
  autoUpdateIntervalMs: Number(setting("PAI_AUTO_UPDATE_INTERVAL_MS") ?? 30 * 60 * 1000),

  /**
   * What "new version" means: "tag" follows the newest `v*` tag, so a release is a tag
   * push and untagged commits are ignored; "branch" follows the checked-out branch.
   */
  updateChannel: (setting("PAI_UPDATE_CHANNEL") ?? "branch") as "branch" | "tag",

  verbose: bool(env.PAI_VERBOSE),
};

export type Config = typeof config;
