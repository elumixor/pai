#!/usr/bin/env bun
/**
 * `bun run desktop` — the desktop app: builds the UI into `desktop/ui/dist`, then hands over
 * to the Tauri CLI. `--build` produces the bundle (a .app and a .dmg on macOS) instead of
 * running it, `--install` puts that app in /Applications and opens it; any other arguments
 * are passed through. The same bundle is what the daemon serves at `/ui`.
 */
import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../src/core/config.ts";

const ui = join(config.repo, "desktop", "ui");
const dist = join(ui, "dist");

export async function buildUi() {
  await mkdir(dist, { recursive: true });
  const result = await Bun.build({
    entrypoints: [join(ui, "src", "main.ts")],
    outdir: dist,
    target: "browser",
    minify: true,
    // Editor languages load on first use, so they are chunks next to the main bundle.
    splitting: true,
    naming: { entry: "[dir]/[name].js", chunk: "chunks/[name]-[hash].js" },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  await cp(join(ui, "index.html"), join(dist, "index.html"));
  await cp(join(ui, "style.css"), join(dist, "style.css"));
  await cp(join(ui, "pai-icon.png"), join(dist, "pai-icon.png"));
  await cp(join(config.repo, "node_modules", "@xterm", "xterm", "css", "xterm.css"), join(dist, "xterm.css"));
}

async function install() {
  const app = join(config.repo, "desktop", "src-tauri", "target", "release", "bundle", "macos", "pai.app");
  const target = "/Applications/pai.app";
  await rm(target, { recursive: true, force: true });
  await cp(app, target, { recursive: true });
  // A locally built app has no quarantine flag, but a rebuilt one keeps the old signature.
  await Bun.spawn(["codesign", "--force", "--deep", "--sign", "-", target], { stdout: "ignore", stderr: "ignore" }).exited;
  console.log(`installed ${target} — it is in Applications now`);
}

if (import.meta.main) {
  await buildUi();
  const args = process.argv.slice(2);
  const wantsInstall = args.includes("--install");
  const build = args.includes("--build") || wantsInstall;
  const proc = Bun.spawn(
    ["bunx", "@tauri-apps/cli@latest", build ? "build" : "dev", ...args.filter((a) => !a.startsWith("--build") && !a.startsWith("--install"))],
    { cwd: join(config.repo, "desktop"), stdout: "inherit", stderr: "inherit", stdin: "inherit" },
  );
  const code = await proc.exited;
  if (code === 0 && wantsInstall) await install();
  process.exit(code);
}
