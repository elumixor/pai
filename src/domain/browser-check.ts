/**
 * Does the browser still work? Every module that reads a signed-in site leans on it — LinkedIn
 * through its own headless pages, every session through the Playwright MCP server — and nothing
 * watched it. On 15 October that cost a morning: the MCP server died and came back while a session
 * held it, the site handle kept a page whose world had gone, and the symptoms were all hangs —
 * `/inbox` returning nothing in 280 seconds, a chat tool call that never came back. A hang is what
 * a dead dependency looks like behind a live-looking facade, so this asks the two questions that
 * cannot be answered from inside it: does the server answer a read made now, and has it been
 * dying under the sessions that hold it.
 */
import { logger } from "../core/log.ts";
import { mcpState } from "./browser.ts";
import * as watch from "./watch.ts";

const log = logger("browser");

/** How often to look, and the first look late enough that the server has had time to come up. */
const EVERY_MS = 10 * 60_000;
const FIRST_MS = 2 * 60_000;
/** Past this a probe counts as unanswered: the whole point is that a dead server hangs. */
const PROBE_TIMEOUT_MS = 5_000;
/** Restarts are self-healing one at a time; this many in one daemon's life is a pattern, not a blip. */
const RESTARTS_WORTH_SAYING = 3;

export interface Signal {
  /** Did the server answer an HTTP request now — any status at all, since the endpoint is not a page. */
  readonly answering: boolean;
  readonly probeMs: number;
  readonly probeError?: string;
  readonly restarts: number;
  /** How long the current server process has been up. */
  readonly upMs: number;
}

const mins = (ms: number) => `${Math.round(ms / 60_000)} min`;

/** The decision, pure. First match wins; undefined means the browser is fine. */
export function unwell(s: Signal): string | undefined {
  if (!s.answering)
    return `the Playwright browser server is not answering (${s.probeError ?? "no answer"} after ${s.probeMs} ms). Every session's browser tools and every signed-in site read through it, and a session holding a dead server hangs instead of failing — which is why this looks like nothing happening rather than an error.`;
  if (s.restarts >= RESTARTS_WORTH_SAYING)
    return `the Playwright browser server answers now, but it has died and been restarted ${s.restarts} times since pai started, the last ${mins(s.upMs)} ago. Each death takes the tool calls of whatever session was holding it, silently, so a browser step that "did nothing" in that window did not run.`;
  return undefined;
}

const TITLE = "pai's browser keeps dying";
const NEXT_ACTION = "Check the daemon log for `playwright mcp exited`; `pai dev restart` starts a fresh server, and a browser step that fell in that window has to be redone";

export const report = (reason: string | undefined) => watch.keep({ title: TITLE, nextAction: NEXT_ACTION, by: "browser-check" }, reason);

/** A request the server must answer; its status does not matter, only that it answered at all. */
async function probe(url: string): Promise<{ answering: boolean; probeMs: number; probeError?: string }> {
  const started = Date.now();
  try {
    await fetch(url, { method: "GET", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), headers: { accept: "text/event-stream" } });
    return { answering: true, probeMs: Date.now() - started };
  } catch (err) {
    return { answering: false, probeMs: Date.now() - started, probeError: (err as Error).message };
  }
}

export async function checkBrowser(nowMs = Date.now()) {
  const state = mcpState();
  report(unwell({ ...(await probe(state.url)), restarts: state.restarts, upMs: nowMs - state.startedAt }));
}

/** Its own timer, outside the browser: an observer sharing a process with what it watches is fine, sharing its loop is not. */
export function startBrowserCheck() {
  const first = setTimeout(() => void checkBrowser(), FIRST_MS);
  const timer = setInterval(() => void checkBrowser(), EVERY_MS);
  log.info(`watching the browser server every ${mins(EVERY_MS)}`);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
