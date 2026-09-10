import type { ServerWebSocket } from "bun";
import { config } from "../core/config.ts";
import { get as getTerminal } from "../domain/terminals.ts";
import { logger } from "../core/log.ts";
import { freePort } from "./port.ts";
import { handle, json } from "./routes.ts";
import { serveApp } from "./app.ts";

const log = logger("server");

const STREAM_PATH = /^\/terminals\/([\w-]+)\/stream$/;

interface TerminalSocket {
  readonly terminalId: string;
  unsubscribe?: () => void;
}

export function startServer() {
  freePort(config.port);
  const server = Bun.serve<TerminalSocket, string>({
    hostname: config.host,
    port: config.port,
    idleTimeout: 0,
    fetch(req, bunServer): Response | Promise<Response> | undefined {
      const { pathname } = new URL(req.url);
      if (pathname === "/") return Response.redirect("/app/", 302);
      if (pathname === "/app" || pathname.startsWith("/app/")) return serveApp(pathname);

      const terminalId = STREAM_PATH.exec(pathname)?.[1];
      if (!terminalId) return handle(req);
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
