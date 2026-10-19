import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

/**
 * `pai channel`: the MCP server `claude` starts in a terminal so that what the user types for
 * this conversation elsewhere — Paigram — arrives here as their next message (Claude Code's
 * channels: `notifications/claude/channel`). It finds its conversation through the session
 * file claude keeps for its process, holds the daemon's `/channel` stream for it, and follows
 * along when the conversation changes (`/clear`, `/resume`). Nothing goes back this way: the
 * daemon reads the transcript and shows the answer in the chat itself (domain/mirror.ts).
 *
 * stdout is the MCP transport; anything to say goes to stderr.
 */

export const CHANNEL_CONFIG = join(homedir(), ".config", "pai", "channel.json");
const SESSIONS = join(homedir(), ".claude", "sessions");
const MARK = "# pai channel";

/**
 * The same server as a plugin from a marketplace of its own: an allowlisted plugin channel loads
 * through `--channels` without the development-channels warning that `server:pai` asks about on
 * every start. The allowlist is a managed setting, so it is a root-owned file put there once.
 * The plugin is installed disabled and switched on per launch, so sessions that are not a
 * terminal's (the box's, which share `~/.claude`) never start it.
 */
const PLUGIN = "pai@pai";
const PLUGIN_ROOT = join(homedir(), ".config", "pai", "channel-plugin");
const INSTALLED = join(homedir(), ".claude", "plugins", "installed_plugins.json");
const MANAGED = join(process.platform === "darwin" ? "/Library/Application Support/ClaudeCode" : "/etc/claude-code", "managed-settings.d", "pai.json");
const ALLOWLIST = { channelsEnabled: true, allowedChannelPlugins: [{ marketplace: "pai", plugin: "pai" }] };

const INSTRUCTIONS =
  'Messages in <channel source="pai"> are the user writing to this conversation from their phone (Paigram, the chat app pai runs in). ' +
  "Treat each one as the user's own next message, exactly as if they had typed it in this terminal, and answer it the same way. " +
  "An [image: <path>] line in one is a picture they attached: Read the file to see it. " +
  "The conversation is mirrored to the phone, so there is no reply tool and nothing to send back.";

const ATTACHMENTS = join(homedir(), ".cache", "pai", "attachments");

/** A picture that came with a message, saved where this terminal can read it; the line that points at it. */
function saveImage(image: { name: string; data: string }) {
  const path = join(ATTACHMENTS, image.name.replace(/[^\w.]/g, ""));
  mkdirSync(ATTACHMENTS, { recursive: true });
  if (!existsSync(path)) writeFileSync(path, Buffer.from(image.data, "base64"));
  return `[image: ${path}]`;
}

/**
 * What `claude` needs to load the channel: the allowlisted plugin when both it and the allowlist are
 * in place, else the server's definition and the switch that lets an unlisted channel push messages.
 */
export function channelArgs(): string[] {
  if (existsSync(MANAGED) && pluginInstalled()) return ["--settings", JSON.stringify({ enabledPlugins: { [PLUGIN]: true } }), "--channels", `plugin:${PLUGIN}`];
  ensureConfig();
  return ["--mcp-config", CHANNEL_CONFIG, "--dangerously-load-development-channels", "server:pai"];
}

function pluginInstalled() {
  try {
    return Boolean(JSON.parse(readFileSync(INSTALLED, "utf8")).plugins?.[PLUGIN]);
  } catch {
    return false;
  }
}

/** Writes the plugin's marketplace and (re)installs it, disabled, when it is new or changed. */
function ensurePlugin() {
  const pai = Bun.which("pai") ?? join(homedir(), ".local", "bin", "pai");
  const files: Record<string, unknown> = {
    ".claude-plugin/marketplace.json": { name: "pai", owner: { name: "pai" }, plugins: [{ name: "pai", source: "./pai", description: "Paigram messages reach this terminal" }] },
    "pai/.claude-plugin/plugin.json": { name: "pai", version: "1.0.0", description: "Paigram messages reach this terminal" },
    "pai/.mcp.json": { mcpServers: { pai: { command: pai, args: ["channel"] } } },
  };
  let changed = false;
  for (const [name, content] of Object.entries(files)) {
    const path = join(PLUGIN_ROOT, name);
    const want = JSON.stringify(content, null, 2);
    if (existsSync(path) && readFileSync(path, "utf8") === want) continue;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, want);
    changed = true;
  }
  const installed = pluginInstalled();
  if (installed && !changed) return;
  const claude = (...args: string[]) => Bun.spawnSync(["claude", "plugin", ...args], { stdout: "ignore", stderr: "inherit" });
  if (installed) claude("uninstall", PLUGIN);
  claude("marketplace", "add", PLUGIN_ROOT);
  claude("marketplace", "update", "pai");
  claude("install", PLUGIN);
  claude("disable", PLUGIN);
}

function ensureConfig() {
  const pai = Bun.which("pai") ?? join(homedir(), ".local", "bin", "pai");
  const want = JSON.stringify({ mcpServers: { pai: { type: "stdio", command: pai, args: ["channel"] } } }, null, 2);
  if (existsSync(CHANNEL_CONFIG) && readFileSync(CHANNEL_CONFIG, "utf8") === want) return;
  mkdirSync(dirname(CHANNEL_CONFIG), { recursive: true });
  writeFileSync(CHANNEL_CONFIG, want);
}

/**
 * `claude` typed in a shell gets the channel too: a function in the shell's rc that adds it,
 * except for claude's own subcommands and one-shot prints, which have no conversation to reach.
 */
export function install(): { rc: string; sudo?: string } {
  ensurePlugin();
  const quote = (arg: string) => (/^[\w./:@-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`);
  const rc = join(homedir(), process.env.SHELL?.endsWith("bash") ? ".bashrc" : ".zshrc");
  const block = [
    MARK,
    "claude() {",
    '  case "$1" in',
    "    mcp|plugin|plugins|update|upgrade|doctor|config|install|setup-token|auth|migrate-installer|-p|--print|-v|--version|-h|--help) command claude \"$@\" ;;",
    `    *) command claude ${channelArgs().map(quote).join(" ")} "$@" ;;`,
    "  esac",
    "}",
    `${MARK} end`,
  ].join("\n");
  const current = existsSync(rc) ? readFileSync(rc, "utf8") : "";
  const start = current.indexOf(MARK);
  const end = current.indexOf(`${MARK} end`);
  const next = start >= 0 && end > start ? current.slice(0, start) + block + current.slice(end + `${MARK} end`.length) : `${current.replace(/\n*$/, "\n")}\n${block}\n`;
  if (next !== current) writeFileSync(rc, next);
  if (existsSync(MANAGED)) return { rc };
  const dir = dirname(MANAGED);
  return { rc, sudo: `sudo mkdir -p "${dir}" && echo '${JSON.stringify(ALLOWLIST)}' | sudo tee "${MANAGED}" >/dev/null` };
}

/** The conversation of the `claude` that started this process: the nearest ancestor with a session file. */
function sessionOf(): string | undefined {
  let pid = process.ppid;
  for (let i = 0; i < 6 && pid > 1; i++) {
    const file = join(SESSIONS, `${pid}.json`);
    if (existsSync(file)) {
      try {
        return (JSON.parse(readFileSync(file, "utf8")) as { sessionId?: string }).sessionId;
      } catch {
        return undefined;
      }
    }
    const parent = Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(pid)]).stdout.toString().trim();
    pid = Number(parent) || 0;
  }
  return undefined;
}

export async function run(api: { base: string; auth: Record<string, string> }) {
  const say = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  const note = (text: string) => process.stderr.write(`pai channel: ${text}\n`);

  createInterface({ input: process.stdin }).on("line", (line) => {
    let msg: { id?: number | string; method?: string; params?: { protocolVersion?: string } };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id === undefined) return; // a notification
    if (msg.method === "initialize")
      say({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
          capabilities: { experimental: { "claude/channel": {} } },
          serverInfo: { name: "pai", version: "1.0.0" },
          instructions: INSTRUCTIONS,
        },
      });
    else if (msg.method === "ping") say({ jsonrpc: "2.0", id: msg.id, result: {} });
    else say({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `${msg.method} is not supported` } });
  });
  process.stdin.on("close", () => process.exit(0));

  let current: string | undefined;
  let abort: AbortController | undefined;

  const listen = async (session: string, signal: AbortSignal) => {
    while (!signal.aborted) {
      try {
        const res = await fetch(`${api.base}/channel?session=${encodeURIComponent(session)}`, { headers: api.auth, signal });
        if (!res.ok || !res.body) throw new Error(`${res.status}`);
        note(`listening for ${session.slice(0, 6)}`);
        let buffer = "";
        for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
          buffer += chunk;
          let cut: number;
          while ((cut = buffer.indexOf("\n\n")) >= 0) {
            const event = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            const data = event
              .split("\n")
              .filter((l) => l.startsWith("data: "))
              .map((l) => l.slice(6))
              .join("\n");
            if (!data) continue;
            const { text, images = [] } = JSON.parse(data) as { text: string; images?: { name: string; data: string }[] };
            say({ jsonrpc: "2.0", method: "notifications/claude/channel", params: { content: [text, ...images.map(saveImage)].filter(Boolean).join("\n"), meta: { from: "paigram" } } });
          }
        }
      } catch (err) {
        if (signal.aborted) return;
        note(`${(err as Error).message}; retrying`);
      }
      await Bun.sleep(3000);
    }
  };

  // The conversation changes under the same process with /clear or /resume; the stream follows it.
  for (;;) {
    const session = sessionOf();
    if (session && session !== current) {
      abort?.abort();
      abort = new AbortController();
      current = session;
      void listen(session, abort.signal);
    }
    await Bun.sleep(2000);
  }
}
