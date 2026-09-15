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
import { readFile } from "node:fs/promises";
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
      for (const controller of reloaders) controller.enqueue("data: reload\n\n");
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

for (const target of ["src", "index.html", "style.css"]) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  watch(join(ui, target), { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => void rebuild(), 80);
  });
}

const server = Bun.serve({
  port,
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

const url = `http://localhost:${server.port}/`;
console.log(`pai client at ${url} — edits under desktop/ui rebuild and reload the page`);
if (!args.includes("--no-open")) Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", url]);
