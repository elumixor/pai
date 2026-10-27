/**
 * The daemon for the browser suite: the real HTTP server on a scratch database, plus a control port the specs use
 * to put things on the bus and in the log — a reply, an ask, a draft — as the sessions would. No session is ever
 * started (the specs answer `/pai` themselves), so no test spends model tokens.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const DAEMON_PORT = 8898;
export const CONTROL_PORT = 8897;
export const TOKEN = "web-suite-token";

const scratch = mkdtempSync(join(tmpdir(), "pai-web-"));
Object.assign(process.env, {
  PAI_DB: join(scratch, "pai.db"),
  PAI_PORT: String(DAEMON_PORT),
  PAI_BIND: "127.0.0.1",
  PAI_NO_TELEGRAM: "1",
  PAI_NO_EDITOR: "1",
  PAI_CONFIG: join(scratch, "config.json"),
  PAI_CLAUDE_PROJECTS: join(scratch, "claude-projects"),
  PAI_TOKEN: TOKEN,
  PAI_KEEP_URL: `http://127.0.0.1:${CONTROL_PORT}`,
  // An ask made at night would otherwise wait for the morning instead of reaching the chat.
  PAI_QUIET_HOURS: "",
});

const { startServer } = await import("../../src/api/server.ts");
const { bus } = await import("../../src/core/bus.ts");
const messages = await import("../../src/domain/messages.ts");
const asks = await import("../../src/domain/asks.ts");
const drafts = await import("../../src/domain/drafts.ts");

startServer();

/** A stand-in for Keep's `elements.js`: the same element name, drawing the URN it was given. */
const ELEMENTS = `customElements.define("keep-pill", class extends HTMLElement {
  connectedCallback() { this.textContent = "Keep · " + this.getAttribute("urn"); this.dataset.ready = "1"; }
});`;

const json = (value: unknown) => Response.json(value, { headers: { "access-control-allow-origin": "*" } });

Bun.serve({
  hostname: "127.0.0.1",
  port: CONTROL_PORT,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/elements.js") return new Response(ELEMENTS, { headers: { "content-type": "text/javascript", "access-control-allow-origin": "*" } });
    const input = req.method === "POST" ? ((await req.json()) as Record<string, never>) : {};
    if (path === "/control/message") return json(messages.log(input));
    if (path === "/control/event") {
      const { kind, payload, sessionId } = input as { kind: string; payload: Record<string, unknown>; sessionId?: string };
      bus.emitEvent(kind, payload, sessionId);
      return json({ ok: true });
    }
    if (path === "/control/ask") return json(asks.ask(input));
    if (path === "/control/draft") return json(drafts.offer(input));
    if (path === "/control/draft-status") return json(drafts.get(Number(new URL(req.url).searchParams.get("id"))));
    return new Response("not found", { status: 404 });
  },
});

console.log(`web suite daemon on ${DAEMON_PORT}, control on ${CONTROL_PORT}`);
