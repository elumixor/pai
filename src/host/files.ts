/**
 * The same files on this machine and the box: `~/dev` and `~/.claude`, two-way over ssh with
 * Mutagen, which runs as a small daemon here and an agent it installs on the box. Safe mode:
 * a file changed on both sides since they last agreed is a conflict Mutagen leaves alone and
 * `pai files` shows; `sync --local` or `--remote` settles them one way.
 */
import { $ } from "bun";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "../core/config.ts";
import { ensureAccess, remote, type Remote } from "./remote.ts";

const localBin = join(homedir(), ".local", "bin");

/** What never travels: build output, Syncthing's leftovers, and of `~/.claude` the login and this machine's scratch. */
const BUILD_OUTPUT = ["node_modules", "target", "dist", ".next", ".venv", "__pycache__", ".DS_Store", "*.log", ".stfolder", ".stignore", "/pai/data", "/pai/menubar/pai-menubar"];
const CLAUDE_LOCAL = [
  ".credentials.json", "/cache", "/backups", "/debug", "/downloads", "/file-history", "/ide", "/jobs", "/paste-cache", "/session-env",
  "/sessions", "/shell-snapshots", "/statsig", "/telemetry", "/tmp", "/todos", "/daemon*", "*.bak*", "*.orig", "/projects/.pai", ".DS_Store", "*.log", ".stfolder", ".stignore",
];

export interface Folder {
  readonly name: string;
  readonly local: string;
  /** On the box, under its home. */
  readonly remote: string;
  readonly ignores: readonly string[];
}

export const FOLDERS: readonly Folder[] = [
  { name: "pai-dev", local: config.devRoot, remote: "dev", ignores: BUILD_OUTPUT },
  { name: "pai-claude", local: join(homedir(), ".claude"), remote: ".claude", ignores: CLAUDE_LOCAL },
];

export interface Conflict {
  readonly path: string;
  readonly local: "changed" | "deleted";
  readonly remote: "changed" | "deleted";
}

export interface FolderStatus {
  readonly name: string;
  readonly local: string;
  readonly remote: string;
  /** Mutagen's word: watching (in sync), scanning, staging-alpha, transitioning, connecting, halted-on-…, or missing. */
  readonly state: string;
  readonly paused: boolean;
  readonly connected: boolean;
  readonly conflicts: readonly Conflict[];
  readonly error?: string;
  readonly files?: number;
  readonly cycles?: number;
}

function binary() {
  const local = join(localBin, "mutagen");
  return existsSync(local) ? local : Bun.which("mutagen");
}

/** Mutagen from its GitHub release, next to `pai`; the agents archive has to sit beside the binary. */
export async function ensureBinary() {
  const found = binary();
  if (found) return found;
  const version = "0.18.1";
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  const url = `https://github.com/mutagen-io/mutagen/releases/download/v${version}/mutagen_${os}_${arch}_v${version}.tar.gz`;
  const script = `set -e; tmp=$(mktemp -d); curl -fsSL "${url}" | tar xz -C "$tmp"; mkdir -p "${localBin}"; install -m 755 "$tmp/mutagen" "${localBin}/mutagen"; cp "$tmp/mutagen-agents.tar.gz" "${localBin}/"`;
  const proc = Bun.spawn(["sh", "-c", script], { stdout: "ignore", stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(`mutagen install failed: ${(await new Response(proc.stderr as ReadableStream).text()).trim().slice(-200)}`);
  return join(localBin, "mutagen");
}

async function mutagen(...args: string[]) {
  const bin = await ensureBinary();
  const res = await $`${bin} ${args}`.nothrow().quiet();
  if (res.exitCode !== 0) throw new Error(`mutagen ${args[0]} ${args[1] ?? ""}: ${res.stderr.toString().trim().split("\n").pop()}`);
  return res.stdout.toString();
}

interface RawSession {
  name: string;
  status: string;
  paused: boolean;
  lastError?: string;
  successfulCycles?: number;
  conflicts?: { root: string; alphaChanges: { old: unknown; new: unknown }[]; betaChanges: { old: unknown; new: unknown }[] }[];
  alpha: { connected: boolean; scanned: boolean; files?: number };
  beta: { connected: boolean; scanned: boolean; files?: number };
}

async function sessions(): Promise<RawSession[]> {
  const out = await mutagen("sync", "list", "--template", "{{json .}}").catch((err: Error) => {
    if (/no synchronization sessions/i.test(err.message)) return "[]";
    throw err;
  });
  const start = out.indexOf("[");
  return start >= 0 ? (JSON.parse(out.slice(start)) as RawSession[]) : [];
}

const box = (): Remote => {
  const r = remote();
  if (!r) throw new Error("no box configured: set PAI_REMOTE=user@host (or PAI_HOST_IP) in .env");
  return r;
};

/** The two sessions, created if missing. Idempotent. */
export async function ensureSessions() {
  const r = box();
  const have = new Set((await sessions()).map((s) => s.name));
  const created: string[] = [];
  for (const folder of FOLDERS) {
    if (have.has(folder.name)) continue;
    await ensureAccess();
    const ignores = folder.ignores.flatMap((i) => ["--ignore", i]);
    await mutagen("sync", "create", "--name", folder.name, "--mode", "two-way-safe", ...ignores, folder.local, `${r.target}:~/${folder.remote}`);
    created.push(folder.name);
  }
  return created;
}

const side = (changes: { old: unknown; new: unknown }[]) => (changes.some((c) => c.new === null || c.new === undefined) ? "deleted" : "changed");

export async function status(): Promise<FolderStatus[]> {
  const found = await sessions();
  return FOLDERS.map((folder) => {
    const s = found.find((x) => x.name === folder.name);
    if (!s) return { name: folder.name, local: folder.local, remote: `~/${folder.remote}`, state: "missing", paused: false, connected: false, conflicts: [] };
    return {
      name: folder.name,
      local: folder.local,
      remote: `~/${folder.remote}`,
      state: s.status,
      paused: s.paused,
      connected: s.alpha.connected && s.beta.connected,
      conflicts: (s.conflicts ?? []).map((c) => ({ path: c.root, local: side(c.alphaChanges), remote: side(c.betaChanges) })),
      error: s.lastError,
      files: s.alpha.files,
      cycles: s.successfulCycles,
    };
  });
}

/** One synchronization cycle now, waited for. */
export const flush = () => mutagen("sync", "flush", ...FOLDERS.map((f) => f.name));
export const pause = () => mutagen("sync", "pause", ...FOLDERS.map((f) => f.name));
export const resume = () => mutagen("sync", "resume", ...FOLDERS.map((f) => f.name));
export const reset = () => mutagen("sync", "reset", ...FOLDERS.map((f) => f.name));

/**
 * Settles every conflict one way: the winning side's version of each conflicting path is
 * copied over the other (or the path deleted there, when the winner has none), then a cycle
 * runs so Mutagen sees them agree.
 */
export async function resolve(winner: "local" | "remote") {
  const r = box();
  await ensureAccess();
  const settled: string[] = [];
  for (const folder of await status()) {
    const spec = FOLDERS.find((f) => f.name === folder.name)!;
    for (const conflict of folder.conflicts) {
      const local = join(spec.local, conflict.path);
      const remotePath = `${spec.remote}/${conflict.path}`;
      const gone = winner === "local" ? conflict.local === "deleted" : conflict.remote === "deleted";
      if (gone) {
        if (winner === "local") await $`ssh ${r.target} ${`rm -rf ${q(remotePath)}`}`.quiet();
        else await $`rm -rf ${local}`.quiet();
      } else if (winner === "local") {
        await $`ssh ${r.target} ${`mkdir -p ${q(dirnameOf(remotePath))}`}`.quiet();
        await $`rsync -a ${local} ${`${r.target}:${remotePath}`}`.quiet();
      } else {
        await $`mkdir -p ${dirnameOf(local)}`.quiet();
        await $`rsync -a ${`${r.target}:${remotePath}`} ${local}`.quiet();
      }
      settled.push(`${folder.name}: ${conflict.path}`);
    }
  }
  if (settled.length) await flush().catch(() => {});
  return settled;
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const dirnameOf = (p: string) => p.slice(0, p.lastIndexOf("/")) || ".";

/** Pending changes on each side, as Mutagen last saw them: what a flush would carry. */
export async function pending() {
  const out: { name: string; text: string }[] = [];
  for (const folder of FOLDERS) {
    const text = await mutagen("sync", "list", "--long", folder.name).catch((err: Error) => err.message);
    out.push({ name: folder.name, text: text.trim() });
  }
  return out;
}
