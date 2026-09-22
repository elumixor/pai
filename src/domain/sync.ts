import type { Subprocess } from "bun";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "../core/config.ts";
import { logger } from "../core/log.ts";

const log = logger("sync");

/**
 * Two-way file sync between the machines that run pai, over Syncthing. The box is the one
 * that is always on, a laptop is intermittent; Syncthing is built for exactly that, needs no
 * VPN and no open port, and resolves a reconnect by itself.
 *
 * Three folders are shared: the projects under `devRoot`, so a laptop can work offline on the
 * same files the box's sessions use; the Claude Code transcripts, so a thread's history is
 * readable with the box unreachable; and the rest of `~/.claude` — settings, skills, agents,
 * commands, plugins, memory — so `claude` on the box is the same `claude` as on the laptop.
 * Messages written offline are the client's outbox, not this.
 */

const localBin = join(homedir(), ".local", "bin");

/** What never travels between machines. */
const BUILD_OUTPUT = ["node_modules", "target", "dist", ".next", ".venv", "__pycache__", ".DS_Store", "*.log"];

/**
 * Of `~/.claude`, what is this machine's alone: its login, its caches and scratch, its
 * shell snapshots, and the transcripts, which are a folder of their own.
 */
const CLAUDE_HOME_LOCAL = [
  "/projects",
  "/.credentials.json",
  "/cache",
  "/backups",
  "/debug",
  "/downloads",
  "/file-history",
  "/ide",
  "/jobs",
  "/paste-cache",
  "/session-env",
  "/sessions",
  "/shell-snapshots",
  "/statsig",
  "/telemetry",
  "/tmp",
  "/todos",
  "/daemon*",
  "/*.bak*",
  "/*.orig",
  ".DS_Store",
  "*.log",
];

const FOLDERS = [
  { id: "pai-projects", label: "projects", path: () => config.devRoot, ignores: BUILD_OUTPUT },
  { id: "pai-transcripts", label: "claude transcripts", path: () => join(homedir(), ".claude", "projects"), ignores: BUILD_OUTPUT },
  { id: "pai-claude-home", label: "claude home", path: () => join(homedir(), ".claude"), ignores: CLAUDE_HOME_LOCAL },
];

let proc: Subprocess | undefined;
let stopping = false;
let apiKey = "";
let deviceId = "";

export const syncStatus = () => ({
  enabled: config.sync.enabled,
  running: Boolean(proc && proc.exitCode === null),
  deviceId,
  peer: config.sync.peer,
  folders: FOLDERS.map((folder) => ({ id: folder.id, path: folder.path() })),
});

export function startSync() {
  if (!config.sync.enabled) return () => {};
  stopping = false;
  void (async () => {
    try {
      await ensureBinary();
      await ensureIdentity();
      spawn();
      await ready();
      await ensureFolders();
      log.info(`device ${deviceId.slice(0, 7)}…${config.sync.peer ? ` paired with ${config.sync.peer.slice(0, 7)}…` : " (no peer yet)"}`);
    } catch (err) {
      log.warn(`not started: ${(err as Error).message}`);
    }
  })();

  return () => {
    stopping = true;
    proc?.kill();
  };
}

async function ensureBinary() {
  if (binary()) return;
  log.info("installing syncthing…");
  const install =
    process.platform === "darwin"
      ? "brew install syncthing"
      : `set -e; tmp=$(mktemp -d); arch=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/'); ` +
        `url=$(curl -fsSL https://api.github.com/repos/syncthing/syncthing/releases/latest | ` +
        `grep -o "https://[^\\"]*linux-$arch[^\\"]*\\.tar\\.gz" | head -1); ` +
        `curl -fsSL "$url" | tar xz -C "$tmp" --strip-components=1; mkdir -p "${localBin}"; ` +
        `install -m 755 "$tmp/syncthing" "${localBin}/syncthing"`;
  const proc = Bun.spawn(["sh", "-c", install], { stdout: "ignore", stderr: "pipe" });
  if ((await proc.exited) !== 0)
    throw new Error(`syncthing install failed: ${(await new Response(proc.stderr as ReadableStream).text()).trim().slice(-200)}`);
  if (!binary()) throw new Error("syncthing is still not on PATH");
}

function binary() {
  const local = join(localBin, "syncthing");
  return existsSync(local) ? local : (Bun.which("syncthing") ?? undefined);
}

/** `syncthing generate` writes a configuration and this machine's device id, once. */
async function ensureIdentity() {
  await mkdir(config.sync.home, { recursive: true });
  if (!existsSync(join(config.sync.home, "config.xml"))) {
    const generate = Bun.spawn([binary()!, "generate", "--home", config.sync.home, "--no-port-probing"], {
      stdout: "ignore",
      stderr: "pipe",
    });
    if ((await generate.exited) !== 0)
      throw new Error(`syncthing generate failed: ${(await new Response(generate.stderr as ReadableStream).text()).trim().slice(-200)}`);
  }
  const xml = await Bun.file(join(config.sync.home, "config.xml")).text();
  apiKey = /<apikey>([^<]+)<\/apikey>/.exec(xml)?.[1] ?? "";
  deviceId = /<device id="([^"]+)"/.exec(xml)?.[1] ?? "";
  if (!apiKey || !deviceId) throw new Error("could not read the syncthing configuration");
}

function spawn() {
  proc = Bun.spawn(
    [
      binary()!,
      "serve",
      "--home",
      config.sync.home,
      "--no-browser",
      "--gui-address",
      `127.0.0.1:${config.sync.guiPort}`,
    ],
    { stdout: "ignore", stderr: "pipe", env: { ...process.env } },
  );
  void (async () => {
    const err = await new Response(proc!.stderr as ReadableStream).text();
    const code = await proc!.exited;
    if (stopping) return;
    log.warn(`syncthing exited (code ${code}) ${err.trim().slice(-200)} — restarting in 5s`);
    setTimeout(spawn, 5000);
  })();
}

const api = async (path: string, init?: RequestInit) => {
  const response = await fetch(`http://127.0.0.1:${config.sync.guiPort}/rest${path}`, {
    ...init,
    headers: { "x-api-key": apiKey, "content-type": "application/json" },
  });
  if (!response.ok) throw new Error(`syncthing ${path}: ${response.status}`);
  return response.status === 204 ? undefined : ((await response.json()) as unknown);
};

async function ready() {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      // The configuration file lists the shared folders' devices before this machine's own
      // entry, so the id read from it may be the peer's; the running instance knows for sure.
      deviceId = ((await api("/system/status")) as { myID: string }).myID || deviceId;
      return;
    } catch {
      await Bun.sleep(250);
    }
  }
  throw new Error("syncthing did not answer its API");
}

/** The shared folders, and the peer on them. Syncthing ignores a request that changes nothing. */
async function ensureFolders() {
  const devices = config.sync.peer ? [{ deviceID: deviceId }, { deviceID: config.sync.peer }] : [{ deviceID: deviceId }];
  if (config.sync.peer)
    await api("/config/devices", {
      method: "PUT",
      body: JSON.stringify([{ deviceID: config.sync.peer, name: "pai peer", autoAcceptFolders: true }]),
    }).catch((err: Error) => log.warn(err.message));

  for (const folder of FOLDERS) {
    await mkdir(folder.path(), { recursive: true });
    // The marker Syncthing wants in a shared directory; missing, the folder sits in an error state.
    await mkdir(join(folder.path(), ".stfolder"), { recursive: true });
    // Build output is reproducible and enormous; syncing it would cost far more than it saves.
    await Bun.write(join(folder.path(), ".stignore"), folder.ignores.join("\n"));
    await api("/config/folders", {
      method: "PUT",
      body: JSON.stringify([
        {
          id: folder.id,
          label: folder.label,
          path: folder.path(),
          type: "sendreceive",
          devices,
          rescanIntervalS: 30,
          fsWatcherEnabled: true,
          ignorePerms: false,
        },
      ]),
    }).catch((err: Error) => log.warn(`${folder.id}: ${err.message}`));
  }
}

/** What is still in flight, per folder, for a client that wants to show it. */
export async function syncProgress() {
  if (!config.sync.enabled || !apiKey) return [];
  const results = [];
  for (const folder of FOLDERS) {
    try {
      const status = (await api(`/db/status?folder=${folder.id}`)) as { state?: string; needBytes?: number };
      results.push({ id: folder.id, state: status.state ?? "unknown", needBytes: status.needBytes ?? 0 });
    } catch {
      results.push({ id: folder.id, state: "unavailable", needBytes: 0 });
    }
  }
  return results;
}
