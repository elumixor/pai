import type { ServerWebSocket } from "bun";
import { config } from "../core/config.ts";
import { get as getTerminal } from "../domain/terminals.ts";
import { logger } from "../core/log.ts";
import { freePort } from "./port.ts";
import { handle, json } from "./routes.ts";
import { isAppPath, serveApp } from "./app.ts";
import { authorized, identified, isPage, rememberToken, tokenFromRequest, unauthorized } from "./auth.ts";
import { googleConfigured, handleAuth, loginUrl, wantsHtml } from "./google.ts";

const log = logger("server");

const STREAM_PATH = /^\/terminals\/([\w-]+)\/stream$/;

interface TerminalSocket {
  readonly terminalId: string;
  unsubscribe?: () => void;
}

/**
 * The desktop app runs from its own origin (`tauri://localhost`), so the API has to say that
 * a different origin may read it. The tailnet is the boundary; there is no cookie to steal.
 */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
};

function withCors(response: Response) {
  for (const [name, value] of Object.entries(CORS)) response.headers.set(name, value);
  return response;
}

export function startServer() {
  freePort(config.port);
  const server = Bun.serve<TerminalSocket, string>({
    hostname: config.host,
    port: config.port,
    idleTimeout: 0,
    async fetch(req, bunServer): Promise<Response | undefined> {
      const url = new URL(req.url);
      const { pathname } = url;
      if (req.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));
      if (pathname.startsWith("/auth/")) return handleAuth(req, url).then((response) => response ?? json({ error: "not found" }, 404));
      const local = !req.headers.has("x-forwarded-for") && ["127.0.0.1", "::1"].includes(bunServer.requestIP(req)?.address ?? "");
      if (!(await authorized(req, url, bunServer.requestIP(req)?.address)) || (googleConfigured() && isPage(pathname) && !local && !(await identified(req, url)))) {
        // A person in a browser is sent to sign in; a program gets the 401 it can act on.
        if (googleConfigured() && wantsHtml(req) && req.method === "GET") return Response.redirect(loginUrl(pathname + url.search), 302);
        return withCors(unauthorized());
      }
      const remember = (response: Response) => rememberToken(response, tokenFromRequest(req, url));
      // The old client lived under these; the web client is at `/`.
      if (/^\/(app|ui)(\/|$)/.test(pathname)) return Response.redirect("/", 302);
      if (isAppPath(pathname)) return serveApp(pathname).then(remember);

      const terminalId = STREAM_PATH.exec(pathname)?.[1];
      if (!terminalId) return handle(req).then(withCors).then(remember);
      if (!getTerminal(terminalId)) return json({ error: "no such terminal" }, 404);
      // An upgraded request has no response; Bun takes the socket over from here.
      if (bunServer.upgrade(req, { data: { terminalId } })) return undefined;
      return json({ error: "expected a websocket upgrade" }, 426);
    },
    websocket: {
      open(ws: ServerWebSocket<TerminalSocket>) {
        const terminal = getTerminal(ws.data.terminalId);
        if (!terminal) return ws.close(1011, "terminal is gone");
        ws.data.unsubscribe = terminal.subscribe((data) => ws.send(data));
      },
      message(ws: ServerWebSocket<TerminalSocket>, message) {
        const terminal = getTerminal(ws.data.terminalId);
        if (!terminal) return ws.close(1011, "terminal is gone");
        terminal.write(typeof message === "string" ? message : new TextDecoder().decode(message));
      },
      close(ws: ServerWebSocket<TerminalSocket>) {
        ws.data.unsubscribe?.();
      },
    },
  });
  log.info(`http://${config.host}:${server.port}`);
  return server;
}

export { restoreDaemonJob } from "./port.ts";
