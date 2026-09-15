import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { baseUrl, closeTerminal, openTerminal, send, terminals as listTerminals, withToken } from "./api.ts";
import { basename, clear, el } from "./dom.ts";
import { icon } from "./icons.ts";
import { isDark, onTheme } from "./theme.ts";
import { save, state } from "./state.ts";
import type { TerminalSummary } from "./types.ts";

/** What is running, as a glyph: the shell until something else takes over. */
const PROCESS_ICON: Record<string, string> = { bun: "🥟", node: "⬢", vim: "✎", nvim: "✎", ssh: "⇄", git: "⑂", claude: "✦", python: "🐍", python3: "🐍", cargo: "⚙", top: "◔", htop: "◔" };
const processLabel = (name: string | undefined) => {
  const short = name ? basename(name) : "";
  return { glyph: PROCESS_ICON[short] ?? "›", name: short };
};

const theme = () => {
  return isDark()
    ? { background: "#0d0f14", foreground: "#d6dae2", cursor: "#8b9cff", selectionBackground: "#2d3550" }
    : { background: "#fbfbfd", foreground: "#1d2230", cursor: "#4a5bd6", selectionBackground: "#d4dafc" };
};

/**
 * The terminal dock: a list of the shells open on the box, one of them shown in an xterm.
 * The PTYs live on the daemon, so switching between them, or closing the window, loses
 * nothing; the screen is replayed when a terminal is shown again.
 */
export function dock(pane: HTMLElement, project: () => { slug?: string; path?: string }) {
  const list = el("div.term-list");
  const host = el("div.term-host");
  let term: Terminal | undefined;
  let socket: WebSocket | undefined;
  let observer: ResizeObserver | undefined;
  let known: TerminalSummary[] = [];

  const detach = () => {
    observer?.disconnect();
    socket?.close();
    term?.dispose();
    term = socket = observer = undefined;
  };

  const attach = (summary: TerminalSummary) => {
    detach();
    state.terminal = summary.id;
    save();
    clear(host);
    term = new Terminal({ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, theme: theme(), cursorBlink: true, allowProposedApi: true });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    const current = term;
    socket = new WebSocket(withToken(`${baseUrl().replace(/^http/, "ws")}/terminals/${summary.id}/stream`));
    const ws = socket;
    ws.addEventListener("message", (event) => current.write(String(event.data)));
    ws.addEventListener("close", () => current.write("\r\n\x1b[2m[disconnected]\x1b[0m\r\n"));
    current.onData((data) => ws.readyState === WebSocket.OPEN && ws.send(data));
    const resize = () => {
      if (!host.clientWidth || !host.clientHeight) return;
      fit.fit();
      void send(`/terminals/${summary.id}`, { cols: current.cols, rows: current.rows });
    };
    observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();
    current.focus();
    render();
  };

  const open = async () => {
    const { slug } = project();
    try {
      const opened = await openTerminal(slug);
      await refresh();
      attach(opened);
    } catch {
      clear(host, el("p.hint", {}, "A terminal needs the daemon; it is not reachable."));
    }
  };

  const render = () => {
    clear(
      list,
      ...known.map((summary) => {
        const { glyph, name } = processLabel(summary.process);
        return el(
          "button.term-tab",
          {
            class: `term-tab${state.terminal === summary.id ? " current" : ""}${summary.alive ? "" : " dead"}`,
            title: `${summary.cwd}\n${name || "shell"}`,
            onclick: () => attach(summary),
          },
          el("span.glyph", {}, glyph),
          el("span.label", {}, basename(summary.cwd)),
          name ? el("span.proc", {}, name) : undefined,
          el(
            "span.iconbtn.close",
            {
              title: "close",
              onclick: async (event: Event) => {
                event.stopPropagation();
                await closeTerminal(summary.id);
                if (state.terminal === summary.id) {
                  detach();
                  state.terminal = undefined;
                  clear(host, placeholder());
                }
                await refresh();
              },
            },
            icon("x", 11),
          ),
        );
      }),
      el("button.term-tab.new", { title: "new terminal in the selected project", onclick: open }, icon("plus", 13), el("span.label", {}, "new")),
    );
  };

  const placeholder = () => el("div.empty", {}, icon("terminal", 22), el("p.dim", {}, "No terminal open."));

  const refresh = async () => {
    try {
      known = (await listTerminals()).filter((t) => t.alive);
    } catch {
      known = [];
    }
    if (state.terminal && !known.some((t) => t.id === state.terminal)) {
      state.terminal = undefined;
      detach();
      clear(host, placeholder());
    }
    render();
  };

  clear(pane, el("div.dock", {}, list, host));
  clear(host, placeholder());
  void refresh().then(() => {
    const remembered = known.find((t) => t.id === state.terminal);
    if (remembered) attach(remembered);
  });
  const timer = setInterval(() => void refresh(), 5000);
  onTheme(() => term && (term.options.theme = theme()));

  return {
    refresh,
    open,
    dispose: () => {
      clearInterval(timer);
      detach();
    },
  };
}
