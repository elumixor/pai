/**
 * The same files on this machine and the box: `~/dev` and `~/.claude`, two-way over ssh with
 * Mutagen, which runs as a small daemon here and an agent it installs on the box. A file
 * changed on both sides since they last agreed is settled on its own in this machine's favour
 * (`two-way-resolved`); `sync --remote` takes the box's side of anything still listed.
 *
 * Except on a machine's first sync: there the two sides never agreed, and this machine winning
 * would put a fresh Mac's defaults (its `~/.claude/settings.json`, a stale clone) over the box
 * and every other Mac. So a first session is `two-way-safe` — differences stay conflicts until
 * settled (`pai files pull` takes the box's) — and becomes `two-way-resolved` once none is left.
 *
 * `.git` never travels: two machines running git on one shared `.git` corrupt it (loose refs
 * from one side overwrite the other's). Each side owns its clone; the working trees are what
 * is shared. `~/dev/.pai-remotes.json`, written here, tells the box where each repository's
 * origin is, so it can give a synced tree a `.git` of its own.
 */
import { $ } from "bun";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../core/config.ts";
import { ensureAccess, remote, type Remote } from "./remote.ts";

const localBin = join(homedir(), ".local", "bin");

/** What never travels: build output, Syncthing's leftovers, and of `~/.claude` the login and this machine's scratch. */
const BUILD_OUTPUT = ["node_modules", "target", "dist", "build", ".build", "DerivedData", ".next", ".nitro", ".output", ".venv", "__pycache__", "SourcePackages", "bazel-*", ".DS_Store", "*.log", ".stfolder", ".stignore", "/pai/data", "/pai/menubar/pai-menubar", "/pai/modules", "/pai/pai.config.local.ts", "/.pai-clone-*"];
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
  /** Bumped when a folder's definition changes, so an old session is replaced. */
  readonly version: number;
}

/** What the box needs to give a synced tree its own `.git`. */
export interface RemoteEntry {
  readonly url: string;
  readonly branch: string;
}
export const REMOTES_FILE = ".pai-remotes.json";

export const FOLDERS: readonly Folder[] = [
  { name: "pai-dev", local: config.devRoot, remote: "dev", ignores: BUILD_OUTPUT, version: 5 },
  { name: "pai-claude", local: join(homedir(), ".claude"), remote: ".claude", ignores: CLAUDE_LOCAL, version: 3 },
];

export interface Conflict {
  readonly path: string;
  readonly local: "changed" | "deleted";
  readonly remote: "changed" | "deleted";
}

/** Something Mutagen could not do on one side: a symlink it will not follow, a file it could not write. */
export interface Problem {
  readonly side: "here" | "box";
  readonly path: string;
  readonly error: string;
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
  readonly problems: readonly Problem[];
  /** The file being staged right now and how far the whole staging is. */
  readonly progress?: { readonly path: string; readonly done: number; readonly total: number };
  readonly error?: string;
  readonly files?: number;
  readonly directories?: number;
  readonly size?: number;
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

interface RawEndpoint {
  connected: boolean;
  scanned: boolean;
  files?: number;
  directories?: number;
  totalFileSize?: number;
  scanProblems?: { path: string; error: string }[];
  transitionProblems?: { path: string; error: string }[];
}

interface RawSession {
  name: string;
  labels?: Record<string, string>;
  status: string;
  paused: boolean;
  lastError?: string;
  successfulCycles?: number;
  conflicts?: { root: string; alphaChanges: { old: unknown; new: unknown }[]; betaChanges: { old: unknown; new: unknown }[] }[];
  stagingStatus?: { path: string; received: number; expected: number };
  alpha: RawEndpoint;
  beta: RawEndpoint;
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

/**
 * The two sessions, created if missing or defined differently than the running one, and a
 * first sync's `two-way-safe` session made `two-way-resolved` once it has no conflicts left.
 * Idempotent.
 */
export async function ensureSessions() {
  const r = box();
  const have = new Map((await sessions()).map((s) => [s.name, s]));
  const created: string[] = [];
  await writeRemotes();
  for (const folder of FOLDERS) {
    const running = have.get(folder.name);
    const first = running ? running.labels?.mode === "safe" : true;
    if (running && running.labels?.version === String(folder.version) && !(first && settled(running))) continue;
    await ensureAccess();
    if (running) await mutagen("sync", "terminate", folder.name);
    const mode = first && !(running && settled(running)) ? "safe" : "resolved";
    const ignores = folder.ignores.flatMap((i) => ["--ignore", i]);
    await mutagen("sync", "create", "--name", folder.name, "--label", `version=${folder.version}`, "--label", `mode=${mode}`, "--mode", `two-way-${mode}`, "--ignore-vcs", ...ignores, folder.local, `${r.target}:~/${folder.remote}`);
    created.push(mode === "safe" ? `${folder.name} (first sync: differences wait as conflicts, \`pai files pull\` takes the box's)` : folder.name);
  }
  return created;
}

/** Both sides agree: a cycle has finished, nothing is in conflict and nothing is moving. */
const settled = (s: RawSession) => s.status === "watching" && (s.successfulCycles ?? 0) > 0 && !s.conflicts?.length;

/**
 * Every repository under `devRoot` with its origin and branch, for the box. The file is synced,
 * so another Mac's entries are kept while their folder exists: a Mac without a clone of some
 * repository does not take it off the box's list.
 */
export async function writeRemotes() {
  const file = join(config.devRoot, REMOTES_FILE);
  const known = (await Bun.file(file).json().catch(() => ({}))) as Record<string, RemoteEntry>;
  const entries: Record<string, RemoteEntry> = Object.fromEntries(Object.entries(known).filter(([name]) => existsSync(join(config.devRoot, name))));
  for (const name of readdirSync(config.devRoot)) {
    const dir = join(config.devRoot, name);
    const cfg = join(dir, ".git", "config");
    if (!existsSync(cfg)) continue;
    const url = /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(readFileSync(cfg, "utf8"))?.[1];
    if (!url) continue;
    const head = readFileSync(join(dir, ".git", "HEAD"), "utf8").trim();
    entries[name] = { url, branch: head.startsWith("ref: refs/heads/") ? head.slice("ref: refs/heads/".length) : "main" };
  }
  await Bun.write(file, JSON.stringify(entries, null, 2));
  return entries;
}

const side = (changes: { old: unknown; new: unknown }[]) => (changes.some((c) => c.new === null || c.new === undefined) ? "deleted" : "changed");

export async function status(): Promise<FolderStatus[]> {
  const found = await sessions();
  return FOLDERS.map((folder) => {
    const s = found.find((x) => x.name === folder.name);
    if (!s) return { name: folder.name, local: folder.local, remote: `~/${folder.remote}`, state: "missing", paused: false, connected: false, conflicts: [], problems: [] };
    const problems = (side: "here" | "box", e: RawEndpoint): Problem[] => [...(e.scanProblems ?? []), ...(e.transitionProblems ?? [])].map((p) => ({ side, path: p.path, error: p.error }));
    return {
      name: folder.name,
      local: folder.local,
      remote: `~/${folder.remote}`,
      state: s.status,
      paused: s.paused,
      connected: s.alpha.connected && s.beta.connected,
      conflicts: (s.conflicts ?? []).map((c) => ({ path: c.root, local: side(c.alphaChanges), remote: side(c.betaChanges) })),
      problems: [...problems("here", s.alpha), ...problems("box", s.beta)],
      progress: s.stagingStatus ? { path: s.stagingStatus.path, done: s.stagingStatus.received, total: s.stagingStatus.expected } : undefined,
      error: s.lastError,
      files: s.alpha.files,
      directories: s.alpha.directories,
      size: s.alpha.totalFileSize,
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
export async function resolve(winner: "local" | "remote", only?: readonly string[]) {
  const r = box();
  await ensureAccess();
  const settled: string[] = [];
  for (const folder of await status()) {
    const spec = FOLDERS.find((f) => f.name === folder.name)!;
    for (const conflict of folder.conflicts) {
      if (only && !only.includes(`${folder.name}:${conflict.path}`)) continue;
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

const short = (p: string) => p.replace(homedir(), "~");
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const dirnameOf = (p: string) => p.slice(0, p.lastIndexOf("/")) || ".";

/**
 * A conflict as a unified diff, this machine's version against the box's: the box's copy is
 * fetched next to a temporary file and `git diff --no-index` compares (a side that deleted the
 * path is `/dev/null`). Binary files say so.
 */
export async function diff(folderName: string, path: string, colour = false): Promise<string> {
  const spec = FOLDERS.find((f) => f.name === folderName);
  if (!spec) throw new Error(`no folder ${folderName}`);
  const r = box();
  await ensureAccess();
  const local = join(spec.local, path);
  const tmp = join(tmpdir(), `pai-diff-${process.pid}-${Math.random().toString(36).slice(2)}`);
  let remoteCopy = "/dev/null";
  const fetched = await $`rsync -a ${`${r.target}:${spec.remote}/${path}`} ${tmp}`.nothrow().quiet();
  if (fetched.exitCode === 0) remoteCopy = tmp;
  const here = existsSync(local) ? local : "/dev/null";
  try {
    const res = await $`git diff --no-index ${colour ? "--color=always" : "--color=never"} -- ${here} ${remoteCopy}`.nothrow().quiet();
    // Git's header names the temporary file; the reader wants the two machines' paths.
    const plain = (l: string) => l.replace(/\x1b\[[0-9;]*m/g, "");
    const body = res.stdout
      .toString()
      .split("\n")
      .filter((l) => !/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode)/.test(plain(l)))
      .map((l) => l.replaceAll(tmp, `~/${spec.remote}/${path}`).replaceAll(local, `${short(spec.local)}/${path}`));
    const dim = (t: string) => (colour ? `\x1b[1m${t}\x1b[0m` : t);
    return [dim(`--- here: ${here === "/dev/null" ? "(deleted)" : `${short(spec.local)}/${path}`}`), dim(`+++ box:  ${remoteCopy === "/dev/null" ? "(deleted)" : `~/${spec.remote}/${path}`}`), ...body].join("\n");
  } finally {
    if (remoteCopy !== "/dev/null") await $`rm -rf ${tmp}`.quiet().nothrow();
  }
}

/** Pending changes on each side, as Mutagen last saw them: what a flush would carry. */
export async function pending() {
  const out: { name: string; text: string }[] = [];
  for (const folder of FOLDERS) {
    const text = await mutagen("sync", "list", "--long", folder.name).catch((err: Error) => err.message);
    out.push({ name: folder.name, text: text.trim() });
  }
  return out;
}
