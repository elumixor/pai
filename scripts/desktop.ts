#!/usr/bin/env bun
/**
 * `bun run desktop` — the desktop app: builds the UI into `desktop/ui/dist`, then hands over
 * to the Tauri CLI. `--build` produces the bundle (a .app and a .dmg on macOS) instead of
 * running it; any other arguments are passed through.
 */
import { cp, mkdir } from "node:fs/promises";
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
    naming: "[dir]/[name].js",
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  await cp(join(ui, "index.html"), join(dist, "index.html"));
  await cp(join(ui, "style.css"), join(dist, "style.css"));
  await cp(join(config.repo, "node_modules", "@xterm", "xterm", "css", "xterm.css"), join(dist, "xterm.css"));
}

if (import.meta.main) {
  await buildUi();
  const args = process.argv.slice(2);
  const build = args.includes("--build");
  const proc = Bun.spawn(
    ["bunx", "@tauri-apps/cli@latest", build ? "build" : "dev", ...args.filter((a) => a !== "--build")],
    { cwd: join(config.repo, "desktop"), stdout: "inherit", stderr: "inherit", stdin: "inherit" },
  );
  process.exit(await proc.exited);
}
