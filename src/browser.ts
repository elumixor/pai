import type { Subprocess } from "bun";
import { config } from "./config.ts";
import { logger } from "./log.ts";

const log = logger("browser");

let proc: Subprocess | undefined;
let stopping = false;

/**
 * One Playwright MCP server for the whole daemon, over HTTP. Every session connecting to
 * it skips the `npx` spawn that otherwise costs seconds on each cold start, and they
 * share one browser profile, so logins persist.
 */
export function startBrowser() {
  stopping = false;
  spawn();
  return () => {
    stopping = true;
    proc?.kill();
  };
}

function spawn() {
  proc = Bun.spawn(
    ["npx", "@playwright/mcp@latest", "--port", String(config.browserPort), "--host", "127.0.0.1", "--headless"],
    { stdout: "ignore", stderr: "pipe", env: { ...process.env } },
  );
  const pid = proc.pid;
  log.info(`playwright mcp on :${config.browserPort} (pid ${pid})`);
  void (async () => {
    const err = await new Response(proc!.stderr as ReadableStream).text();
    const code = await proc!.exited;
    if (stopping) return;
    log.warn(`playwright mcp exited (code ${code}) ${err.trim().slice(-300)} — restarting in 5s`);
    setTimeout(spawn, 5000);
  })();
}

export function browserMcp() {
  // The server checks the Host header; "localhost" is what it accepts by default.
  return { type: "http" as const, url: `http://localhost:${config.browserPort}/mcp` };
}
