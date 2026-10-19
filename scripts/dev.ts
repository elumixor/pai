#!/usr/bin/env bun
/**
 * `bun run dev` — the client in a browser, rebuilt on every save. The page is served from
 * `desktop/ui/dist` on its own port and talks to whatever daemon it can reach (this
 * machine's first, then the box), exactly as the desktop app does; `/__config` hands it the
 * address and token from `~/.config/pai/menubar` the way the Tauri shell would.
 *
 * `--no-open` leaves the browser alone; `--port <n>` picks the port.
 */
import { watch } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "../src/core/config.ts";
import { buildUi } from "./desktop.ts";

const ui = join(config.repo, "desktop", "ui");
const dist = join(ui, "dist");
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1] || 0) || 5180;

const reloaders = new Set<ReadableStreamDefaultController<string>>();
let building: Promise<void> | undefined;

async function rebuild() {
  if (building) return building;
  building = buildUi()
    .then(() => {
      for (const controller of reloaders) {
        try {
          controller.enqueue("data: reload\n\n");
        } catch {
          reloaders.delete(controller); // the tab closed without cancelling
        }
      }
      console.log(`${new Date().toLocaleTimeString()} rebuilt`);
    })
    .catch((err: Error) => console.error(err.message))
    .finally(() => (building = undefined));
  return building;
}

const RELOAD = `<script>new EventSource("/__reload").onmessage=()=>location.reload()</script>`;

async function configured() {
  const lines = (await readFile(join(homedir(), ".config", "pai", "menubar"), "utf8").catch(() => ""))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return { baseUrl: lines[0]?.replace(/\/$/, ""), token: lines[1] };
}

await buildUi();

let timer: ReturnType<typeof setTimeout> | undefined;
const changed = () => {
  clearTimeout(timer);
  timer = setTimeout(() => void rebuild(), 80);
};
for (const target of ["src", "index.html", "style.css", "pai-icon.png"]) watch(join(ui, target), { recursive: true }, changed);
// fs.watch on macOS goes quiet after a while (a replaced inode, a long-lived process): a cheap mtime sweep catches what it misses.
let newest = 0;
const sweep = async () => {
  let latest = 0;
  for (const file of ["index.html", "style.css", ...(await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: join(ui, "src") }))).map((f) => join("src", f))])
    latest = Math.max(latest, (await stat(join(ui, file))).mtimeMs);
  if (newest && latest > newest) changed();
  newest = latest;
};
await sweep();
setInterval(() => void sweep(), 1000);

/** Whether a dev server of ours already answers on a port: then this one is the second, and only opens the page. */
const ours = (p: number) =>
  fetch(`http://localhost:${p}/__config`, { signal: AbortSignal.timeout(500) })
    .then((r) => r.ok)
    .catch(() => false);

/** Listens on the port asked for, or the next free one; a port held by an earlier `bun run dev` is reused as it is. */
async function listen(from: number) {
  for (let p = from; p < from + 20; p += 1) {
    try {
      return { server: serve(p) };
    } catch (err) {
      if ((err as { code?: string }).code !== "EADDRINUSE") throw err;
      if (await ours(p)) return { running: p };
    }
  }
  throw new Error(`no free port from ${from} up`);
}

const serve = (p: number) => Bun.serve({
  port: p,
  // The reload stream stays open as long as the tab does.
  idleTimeout: 0,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/__reload")
      return new Response(
        new ReadableStream<string>({
          start: (controller) => reloaders.add(controller),
          cancel: (controller) => reloaders.delete(controller),
        }),
        { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } },
      );
    if (pathname === "/__config") return Response.json(await configured());
    const file = Bun.file(join(dist, pathname === "/" ? "index.html" : pathname));
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    if (!pathname.endsWith(".html") && pathname !== "/") return new Response(file);
    return new Response((await file.text()).replace("</body>", `${RELOAD}</body>`), { headers: { "content-type": "text/html" } });
  },
});

const started = await listen(port);
const url = `http://localhost:${started.running ?? started.server!.port}/`;
if (started.running) console.log(`a dev server is already running at ${url} — it rebuilds on save; this one leaves it to it`);
else console.log(`pai client at ${url} — edits under desktop/ui rebuild and reload the page`);
if (!args.includes("--no-open")) Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", url]);
if (started.running) process.exit(0);
