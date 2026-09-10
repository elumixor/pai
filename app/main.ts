import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

interface SessionSummary {
  readonly shortId: string;
  readonly title: string;
  readonly state: string;
  readonly project?: string;
}

interface TerminalSummary {
  readonly id: string;
  readonly cwd: string;
  readonly project?: string;
  readonly alive: boolean;
}

interface ProjectSummary {
  readonly slug: string;
  readonly summary: string;
}

const el = <T extends HTMLElement>(id: string) => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing element: ${id}`);
  return found as T;
};

const stage = el("stage");
const sessionList = el<HTMLUListElement>("sessions");
const terminalList = el<HTMLUListElement>("terminals");
const projectSelect = el<HTMLSelectElement>("project");

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

let active: { id: string; socket: WebSocket; terminal: Terminal; fit: FitAddon } | undefined;

function attach(id: string) {
  active?.socket.close();
  active?.terminal.dispose();
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

  const resize = () => {
    fit.fit();
    void json(`/terminals/${id}`, { method: "POST", body: JSON.stringify({ cols: terminal.cols, rows: terminal.rows }) });
  };
  terminal.onResize(resize);
  window.addEventListener("resize", resize);

  active = { id, socket, terminal, fit };
  void render();
}

function button(label: string, sub: string, current: boolean, onClick: () => void) {
  const item = document.createElement("li");
  const control = document.createElement("button");
  control.textContent = label;
  control.ariaCurrent = String(current);
  control.addEventListener("click", onClick);
  const detail = document.createElement("small");
  detail.textContent = sub;
  control.append(detail);
  item.append(control);
  return item;
}

async function render() {
  const [{ live }, terminals] = await Promise.all([
    json<{ live: SessionSummary[] }>("/tasks"),
    json<TerminalSummary[]>("/terminals"),
  ]);

  sessionList.replaceChildren(
    ...live.map((session) =>
      button(session.title || session.shortId, `${session.state}${session.project ? ` · ${session.project}` : ""}`, false, () => {}),
    ),
  );

  terminalList.replaceChildren(
    ...terminals.map((terminal) =>
      button(terminal.project ?? terminal.cwd.split("/").pop() ?? terminal.id, terminal.id, terminal.id === active?.id, () =>
        attach(terminal.id),
      ),
    ),
  );

  if (!active && terminals.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No terminal open. Pick a project and start one.";
    stage.replaceChildren(empty);
  }
}

el<HTMLFormElement>("open").addEventListener("submit", async (event) => {
  event.preventDefault();
  const project = projectSelect.value || undefined;
  const opened = await json<TerminalSummary>("/terminals", { method: "POST", body: JSON.stringify({ project }) });
  attach(opened.id);
});

const health = await json<{ pid: number; uptime: number }>("/health");
el("host").textContent = `pid ${health.pid} · up ${Math.round(health.uptime / 60)}m`;

const projects = await json<ProjectSummary[]>("/projects");
projectSelect.replaceChildren(
  new Option("home", ""),
  ...projects.map((project) => new Option(project.slug, project.slug)),
);

await render();
setInterval(() => void render(), 5000);
