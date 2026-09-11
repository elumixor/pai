import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { clear, el, json, post } from "../dom.ts";
import type { ProjectSummary, TerminalSummary } from "../types.ts";

interface Attached {
  readonly id: string;
  readonly socket: WebSocket;
  readonly terminal: Terminal;
}

let attached: Attached | undefined;

export function stopTerminals() {
  attached?.socket.close();
  attached?.terminal.dispose();
  attached = undefined;
}

export async function terminals(side: HTMLElement, pane: HTMLElement) {
  const [open, projects] = await Promise.all([
    json<TerminalSummary[]>("/terminals"),
    json<ProjectSummary[]>("/projects"),
  ]);

  const stage = el("div", { id: "stage" });
  clear(pane, stage);

  const attach = (id: string) => {
    stopTerminals();
    stage.replaceChildren();

    const terminal = new Terminal({ fontSize: 13, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(stage);
    fit.fit();

    const socket = new WebSocket(`ws://${location.host}/terminals/${id}/stream`);
    socket.addEventListener("message", (event) => terminal.write(String(event.data)));
    socket.addEventListener("close", () => terminal.writeln("\r\n[disconnected]"));
    terminal.onData((data) => socket.readyState === WebSocket.OPEN && socket.send(data));
    terminal.onResize(() => void post(`/terminals/${id}`, { cols: terminal.cols, rows: terminal.rows }));
    window.addEventListener("resize", () => fit.fit());

    attached = { id, socket, terminal };
    terminal.focus();
  };

  const picker = el(
    "select",
    {},
    el("option", { value: "" }, "home"),
    ...projects.map((project) => el("option", { value: project.slug }, project.slug)),
  ) as HTMLSelectElement;

  const form = el(
    "form.compose",
    {
      onsubmit: async (event: Event) => {
        event.preventDefault();
        const opened = await post<TerminalSummary>("/terminals", { project: picker.value || undefined });
        await terminals(side, pane);
        attach(opened.id);
      },
    },
    picker,
    el("button.action", { type: "submit" }, "New"),
  );

  clear(
    side,
    el("h2", {}, "Terminals"),
    ...(open.length
      ? open.map((terminal) =>
          el(
            "button.row",
            { onclick: () => attach(terminal.id) },
            el("span.grow", {}, terminal.project ?? terminal.cwd.split("/").pop() ?? terminal.id),
            el("span.dim", {}, terminal.id),
          ),
        )
      : [el("p.empty", {}, "none open")]),
    form,
  );

  if (attached) attach(attached.id);
  else if (open[0]) attach(open[0].id);
}
