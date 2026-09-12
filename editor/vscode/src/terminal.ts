import * as vscode from "vscode";
import WebSocket from "ws";
import { post, socketUrl, type TerminalSummary } from "./api.ts";

/** A PTY on the box, rendered as a normal editor terminal: the websocket is the pty. */
export function attach(terminal: TerminalSummary) {
  const write = new vscode.EventEmitter<string>();
  const close = new vscode.EventEmitter<number>();
  let socket: WebSocket | undefined;

  const pty: vscode.Pseudoterminal = {
    onDidWrite: write.event,
    onDidClose: close.event,
    open() {
      socket = new WebSocket(socketUrl(`/terminals/${terminal.id}/stream`));
      socket.on("message", (data: Buffer | string) => write.fire(data.toString()));
      socket.on("error", (err: Error) => write.fire(`\r\n[pai] ${err.message}\r\n`));
      socket.on("close", () => close.fire(0));
    },
    close() {
      socket?.close();
    },
    handleInput(data) {
      if (socket?.readyState === WebSocket.OPEN) socket.send(data);
    },
    setDimensions({ columns, rows }) {
      void post(`/terminals/${terminal.id}`, { cols: columns, rows }).catch(() => {});
    },
  };

  vscode.window.createTerminal({ name: `pai · ${terminal.project ?? terminal.cwd}`, pty }).show();
}

export async function openTerminal(project?: string) {
  attach(await post<TerminalSummary>("/terminals", project ? { project } : {}));
}
