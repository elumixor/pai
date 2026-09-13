import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { baseUrl, get, send, token, withToken } from "./api.ts";
import { clear, el } from "./dom.ts";
import type { TerminalSummary } from "./types.ts";

/** A PTY on the box in an xterm, over the daemon's terminal websocket. */
export async function terminal(pane: HTMLElement, project?: string) {
  const host = el("div.term");
  clear(pane, el("header.pane-head", {}, el("h2", {}, "Terminal"), el("span.dim", {}, project ?? "home")), host);

  let summary: TerminalSummary;
  try {
    const response = await fetch(`${baseUrl()}/terminals`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token() ? { authorization: `Bearer ${token()}` } : {}) },
      body: JSON.stringify(project ? { project } : {}),
    });
    summary = (await response.json()) as TerminalSummary;
  } catch {
    host.append(el("p.empty", {}, "A terminal needs the daemon; this one is offline."));
    return () => {};
  }

  const term = new Terminal({
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 12,
    theme: { background: "#0f1115", foreground: "#d7dae0", cursor: "#7aa2f7" },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  fit.fit();

  const socket = new WebSocket(withToken(`${baseUrl().replace(/^http/, "ws")}/terminals/${summary.id}/stream`));
  socket.addEventListener("message", (event) => term.write(String(event.data)));
  term.onData((data) => socket.readyState === WebSocket.OPEN && socket.send(data));
  const resize = () => {
    fit.fit();
    void send(`/terminals/${summary.id}`, { cols: term.cols, rows: term.rows });
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);

  return () => {
    observer.disconnect();
    socket.close();
    term.dispose();
    void get(`/terminals`).catch(() => {});
  };
}
