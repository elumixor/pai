import type { Subprocess } from "bun";
import { config } from "../core/config.ts";
import { logger } from "../core/log.ts";

const log = logger("browser");

let proc: Subprocess | undefined;
let stopping = false;
/** Every spawn after the first is the server having died under the sessions holding it. */
let restarts = 0;
let startedAt = Date.now();

/** Pinned: the daemon is long-lived, and `@latest` would change the browser under it on any restart. */
const MCP = "@playwright/mcp@0.0.83";
/**
 * The default is the branded `chrome` channel, which is not on the box and is not worth a 150MB
 * download per rebuild; `chromium` is Playwright's own build, pinned to the version above.
 */
const BROWSER = "chromium";
/** What `--browser chromium` resolves to, and what install-browser installs under ~/.cache/ms-playwright. */
const BUILD = "chrome-for-testing";

/**
 * One Playwright MCP server for the whole daemon, over HTTP. Every session connecting to
 * it skips the `npx` spawn that otherwise costs seconds on each cold start, and they
 * share one browser profile, so logins persist.
 */
export function startBrowser() {
  stopping = false;
  void (async () => {
    await installBrowser();
    if (!stopping) spawn();
  })();
  return () => {
    stopping = true;
    proc?.kill();
  };
}

/**
 * Nothing should have to be installed by hand on the box: a missing browser only shows up as a
 * failed navigation inside an agent's turn. A second or two when it is already there. `--no-remove`
 * keeps it from evicting the build another playwright (the browser module's) is pinned to.
 */
async function installBrowser() {
  const install = Bun.spawn(["npx", MCP, "install-browser", BUILD, "--no-progress", "--no-remove"], { stdout: "ignore", stderr: "pipe", env: { ...process.env } });
  const err = await new Response(install.stderr as ReadableStream).text();
  const code = await install.exited;
  if (code === 0) log.info(`${BROWSER} ready`);
  else log.warn(`installing ${BROWSER} failed (code ${code}) ${err.trim().slice(-300)} — starting anyway`);
}

function spawn() {
  proc = Bun.spawn(
    ["npx", MCP, "--port", String(config.browserPort), "--host", "127.0.0.1", "--headless", "--browser", BROWSER],
    { stdout: "ignore", stderr: "pipe", env: { ...process.env } },
  );
  const pid = proc.pid;
  startedAt = Date.now();
  log.info(`playwright mcp on :${config.browserPort} (pid ${pid})`);
  void (async () => {
    const err = await new Response(proc!.stderr as ReadableStream).text();
    const code = await proc!.exited;
    if (stopping) return;
    restarts += 1;
    log.warn(`playwright mcp exited (code ${code}) ${err.trim().slice(-300)} — restarting in 5s`);
    setTimeout(spawn, 5000);
  })();
}

/**
 * What the server has been doing, for the observer that watches it: when this process last started
 * it, and how often it has had to. A session holding a connection to a dead server hangs rather
 * than failing, so a restart is never free.
 */
export function mcpState() {
  return { restarts, startedAt, url: `http://localhost:${config.browserPort}/mcp` };
}

export function browserMcp() {
  // The server checks the Host header; "localhost" is what it accepts by default.
  return { type: "http" as const, url: `http://localhost:${config.browserPort}/mcp` };
}
