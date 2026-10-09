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
  workspace: resolve(setting("PAI_WORKSPACE") ?? join(repo, "workspace")),

  /** Root that gets scanned for coding projects. */
  devRoot: resolve(setting("PAI_DEV_ROOT") ?? join(homedir(), "dev")),
  scanDepth: Number(env.PAI_SCAN_DEPTH ?? 2),

  /** The HTTP API. Loopback by default; the tailnet address when other devices need it. */
  port: Number(setting("PAI_PORT") ?? 8787),
  host: setting("PAI_BIND") ?? tailnetAddress() ?? "127.0.0.1",

  /**
   * The browser editor (code-server with the pai extension), started and supervised by the
   * daemon on the same address as the API. PAI_NO_EDITOR=1 turns it off.
   */
  editor: {
    enabled: !bool(setting("PAI_NO_EDITOR")),
    port: Number(setting("PAI_EDITOR_PORT") ?? 8788),
    host: setting("PAI_EDITOR_BIND") ?? setting("PAI_BIND") ?? tailnetAddress() ?? "127.0.0.1",
    /**
     * On a public daemon the editor is a shell in a browser. With Google sign-in the proxy
     * guards it; otherwise it falls back to the token as its password.
     */
    password: env.PAI_EDITOR_PASSWORD ?? (bool(setting("PAI_PUBLIC")) && !env.PAI_GOOGLE_CLIENT_ID ? (setting("PAI_TOKEN") ?? "") : ""),
  },

  /** Shared Playwright MCP server, one per daemon. */
  browserPort: Number(setting("PAI_BROWSER_PORT") ?? 8931),

  dbPath: resolve(env.PAI_DB ?? join(repo, "data", "pai.db")),

  /** Project-scoped Hetzner Cloud API token, read-only use: pricing the host actually costs. */
  hcloudToken: env.HCLOUD_TOKEN ?? "",
  /** Vercel AI Gateway, for the small jobs around the sessions: the gist of a long message. */
  aiGatewayKey: env.AI_GATEWAY_API_KEY ?? "",

  /**
   * The box, as `user@host`, for `pai ssh` and `pai claude` from a laptop. Defaults to the
   * Hetzner host's address as the `pai` user; `PAI_REMOTE=0` means there is no box.
   */
  remote: setting("PAI_REMOTE") ?? (env.PAI_HOST_IP ? `pai@${env.PAI_HOST_IP}` : ""),

  /**
   * A shared secret every client must present once the daemon is reachable from anywhere but
   * loopback. Without it `public` refuses to expose anything.
   */
  token: setting("PAI_TOKEN") ?? "",

  /**
   * Sign in with Google for the browser surfaces. The client id and secret are an OAuth
   * client of yours (Google Cloud console); the allowlist is who may get in.
   */
  google: {
    clientId: env.PAI_GOOGLE_CLIENT_ID ?? "",
    clientSecret: env.PAI_GOOGLE_CLIENT_SECRET ?? "",
    allowed: (setting("PAI_GOOGLE_ALLOWED") ?? "")
      .split(/[,\s]+/)
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  },

  /** Put the daemon on the public internet: Caddy on 80/443, run by the daemon, https included. */
  public: bool(setting("PAI_PUBLIC")),

  /** A domain of your own pointing at this host. Empty means `<public ip>.sslip.io`. */
  domain: setting("PAI_DOMAIN") ?? "",

  /**
   * Where clients link back to this daemon. Explicit `PAI_BASE_URL` wins; otherwise a public
   * daemon with a domain links to its https address, and anything else has no links.
   */
  baseUrl: (
    setting("PAI_BASE_URL") ??
    (bool(setting("PAI_PUBLIC")) && setting("PAI_DOMAIN") ? `https://${setting("PAI_DOMAIN")}` : "")
  ).replace(/\/$/, ""),

  models: {
    main: setting("PAI_MAIN_MODEL") ?? "sonnet",
    task: setting("PAI_TASK_MODEL") ?? "sonnet",
    /** The cheap pass that routes batches of incoming events (watchers → triage). */
    triage: setting("PAI_TRIAGE_MODEL") ?? "haiku",
  },

  /** The user's time zone: schedules, quiet hours, the journal's dates and the 04:00 rotation are read in it. */
  timezone: setting("PAI_TIMEZONE") ?? "Europe/Prague",

  /** `HH:MM-HH:MM` in that zone: notices other than urgent ones are held; agents keep working. */
  quietHours: setting("PAI_QUIET_HOURS") ?? "23:00-08:00",

  /** claude.ai connectors no session gets, by name (comma-separated): the calendar is Balance's, not Google's. */
  deniedConnectors: (setting("PAI_DENY_CONNECTORS") ?? "claude.ai Google Calendar").split(",").map((name) => name.trim()).filter(Boolean),

  /** Agents working at once; the rest queue. A coding agent counts double. */
  maxWorkingAgents: Number(setting("PAI_MAX_AGENTS") ?? 4),

  /** The hour (in the user's zone) the orchestrator's session is rebuilt from the journal and a briefing. */
  rotateHour: Number(setting("PAI_ROTATE_HOUR") ?? 4),

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

  verbose: bool(setting("PAI_VERBOSE")),
};

export type Config = typeof config;
