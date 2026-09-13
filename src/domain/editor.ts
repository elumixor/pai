import type { Subprocess } from "bun";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "../core/config.ts";
import { logger } from "../core/log.ts";

const log = logger("editor");

const source = join(config.repo, "editor", "vscode");
const userDir = join(homedir(), ".local", "share", "code-server");
const EXTENSION_ID = "elumixor.pai-vscode";
const extensionLink = join(userDir, "extensions", EXTENSION_ID);
const localBin = join(homedir(), ".local", "bin");

let proc: Subprocess | undefined;
let stopping = false;

export const editorUrl = () => `http://${config.editor.host}:${config.editor.port}`;

export const editorStatus = () => ({
  enabled: config.editor.enabled,
  url: config.editor.enabled ? editorUrl() : undefined,
  running: Boolean(proc && proc.exitCode === null),
});

/**
 * code-server with the pai extension, supervised like any other child of the daemon: it
 * comes up with the daemon, comes back if it dies, and a new version of the extension is
 * built on the way up. Nothing has to be installed by hand on the box.
 */
export function startEditor() {
  if (!config.editor.enabled) return () => {};
  stopping = false;
  void (async () => {
    try {
      await ensure();
    } catch (err) {
      log.warn(`not started: ${(err as Error).message}`);
      return;
    }
    if (!stopping) spawn();
  })();
  return () => {
    stopping = true;
    proc?.kill();
  };
}

async function ensure() {
  await buildExtension();
  await link();
  await settings();
  await binary();
}

/** The extension is bundled in-process: no `vsce`, no network, nothing to package. */
async function buildExtension() {
  const result = await Bun.build({
    entrypoints: [join(source, "src", "extension.ts")],
    outdir: join(source, "out"),
    target: "node",
    format: "cjs",
    external: ["vscode"],
  });
  if (!result.success) throw new Error(`extension build failed: ${result.logs.join(" ")}`);
}

/**
 * The extension is copied into code-server's extensions directory and registered in its
 * `extensions.json` — exactly what `--install-extension` would have left behind, without
 * needing a packaged `.vsix`. A symlink is not enough: the scanner skips entries that are
 * not real directories. Copying again on every start is how an update reaches the editor.
 */
async function link() {
  const extensions = join(userDir, "extensions");
  await mkdir(extensions, { recursive: true });
  // A copy left by an earlier `--install-extension` would load a second time, from stale code.
  for (const entry of await readdir(extensions).catch(() => []))
    if (entry.startsWith(EXTENSION_ID) && entry !== EXTENSION_ID)
      await rm(join(extensions, entry), { recursive: true, force: true });
  await rm(extensionLink, { recursive: true, force: true });
  await mkdir(extensionLink, { recursive: true });
  for (const entry of ["package.json", "README.md", "out", "media"])
    await cp(join(source, entry), join(extensionLink, entry), { recursive: true });

  const manifest = join(extensions, "extensions.json");
  const installed = existsSync(manifest)
    ? (JSON.parse(await readFile(manifest, "utf8")) as { identifier: { id: string } }[])
    : [];
  const { version } = JSON.parse(await readFile(join(source, "package.json"), "utf8")) as { version: string };
  const entry = {
    identifier: { id: EXTENSION_ID },
    version,
    location: { $mid: 1, fsPath: extensionLink, path: extensionLink, scheme: "file" },
    relativeLocation: EXTENSION_ID,
    metadata: { isApplicationScoped: false, isMachineScoped: false, isBuiltin: false, installedTimestamp: Date.now(), source: "vsix" },
  };
  await writeFile(manifest, JSON.stringify([...installed.filter((e) => e.identifier.id !== EXTENSION_ID), entry]));
}

/** The extension finds the daemon through settings, so a fresh editor needs no configuration. */
async function settings() {
  const path = join(userDir, "User", "settings.json");
  await mkdir(join(path, ".."), { recursive: true });
  const current = existsSync(path) ? (JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>) : {};
  const daemon = config.baseUrl || `http://127.0.0.1:${config.port}`;
  await writeFile(
    path,
    JSON.stringify(
      {
        ...current,
        "pai.baseUrl": daemon,
        // The box runs the user's own code by design; a trust prompt would only disable extensions.
        "security.workspace.trust.enabled": false,
      },
      null,
      2,
    ),
  );
}

async function binary() {
  const found = await which();
  if (found) return found;
  log.info("installing code-server…");
  const install =
    process.platform === "darwin"
      ? "brew install code-server"
      : `curl -fsSL https://code-server.dev/install.sh | sh -s -- --method=standalone --prefix="${join(homedir(), ".local")}"`;
  const proc = Bun.spawn(["sh", "-c", install], { stdout: "ignore", stderr: "pipe" });
  if ((await proc.exited) !== 0) {
    const err = await new Response(proc.stderr as ReadableStream).text();
    throw new Error(`code-server install failed: ${err.trim().slice(-300)}`);
  }
  const installed = await which();
  if (!installed) throw new Error("code-server is still not on PATH after installing");
  return installed;
}

/** The standalone install lands in `~/.local/bin`, which a service's PATH usually misses. */
async function which() {
  const local = join(localBin, "code-server");
  if (existsSync(local)) return local;
  const found = Bun.which("code-server");
  return found ?? undefined;
}

function spawn() {
  void (async () => {
    const bin = await which();
    if (!bin) return;
    proc = Bun.spawn(
      [
        bin,
        "--bind-addr",
        `${config.editor.host}:${config.editor.port}`,
        "--auth",
        config.editor.password ? "password" : "none",
        "--disable-telemetry",
        "--disable-update-check",
        config.devRoot,
      ],
      {
        cwd: config.devRoot,
        stdout: "ignore",
        stderr: "pipe",
        env: { ...process.env, PASSWORD: config.editor.password || undefined, PATH: `${localBin}:${process.env.PATH}` },
      },
    );
    log.info(`${editorUrl()} (pid ${proc.pid})`);
    const err = await new Response(proc.stderr as ReadableStream).text();
    const code = await proc.exited;
    if (stopping) return;
    log.warn(`code-server exited (code ${code}) ${err.trim().slice(-300)} — restarting in 5s`);
    setTimeout(spawn, 5000);
  })();
}
