import { baseUrl, fileIndex, flush, follow, inDesktop, isOnline, lastError, onConnection, outbox, projects, resolveBase, send, status, usage } from "./api.ts";
import { dashboard } from "./dashboard.ts";
import { ask, clear, el, sheet, until } from "./dom.ts";
import { editor, emptyEditor } from "./editor.ts";
import { tree } from "./files.ts";
import { icon, type IconName } from "./icons.ts";
import { palette, type Command } from "./palette.ts";
import { addProjectDialog, allThreads, projectOf, rail } from "./rail.ts";
import { DOWNLOAD, settingsView } from "./settings.ts";
import { splits } from "./splits.ts";
import { save, state } from "./state.ts";
import { dock } from "./terminals.ts";
import "./theme.ts";
import { thread } from "./thread.ts";
import type { ProjectSummary, SessionSummary } from "./types.ts";

const $ = (id: string) => document.getElementById(id)!;
const main = $("main");
const filesCol = $("files");
const viewerPane = $("viewer");
const dockPane = $("dock");
const slots = { a: $("thread-a"), b: $("thread-b") } as const;
const railCol = $("rail");
const statusbar = $("statusbar");

let catalog: ProjectSummary[] = [];
let sessions: SessionSummary[] = [];
const currentProject = () => catalog.find((p) => p.slug === state.project);

// ---- the centre pane: the editor, the dashboard, or the settings ------------------------

let disposeCenter: () => void = () => {};
const showCenter = async (open: () => Promise<(() => void) | void> | (() => void) | void) => {
  disposeCenter();
  disposeCenter = (await open()) ?? (() => {});
};
const openFile = (path: string) => {
  state.file = path;
  save();
  void showCenter(() => editor(viewerPane, path));
};
const showDashboard = () => void dashboard(sheet("dashboard"));
const showSettings = () => void settingsView(sheet("settings"));
const showEditor = () => (state.file ? openFile(state.file) : emptyEditor(viewerPane));

// ---- the two thread panes ----------------------------------------------------------------

const disposeThread = { a: () => {}, b: () => {} };
const slotState = { a: () => state.threadA, b: () => state.threadB } as const;
const setSlot = (slot: "a" | "b", id: string | undefined) => {
  if (slot === "a") state.threadA = id;
  else state.threadB = id;
  save();
};

function emptySlot(slot: "a" | "b") {
  disposeThread[slot]();
  disposeThread[slot] = () => {};
  setSlot(slot, undefined);
  clear(slots[slot], slot === "a" ? el("div.empty", {}, icon("message", 24), el("p.dim", {}, "Pick a thread, or ⌘K."), el("button.btn", { onclick: () => newThread(state.project) }, "New thread")) : undefined);
  main.classList.toggle("b-empty", !state.threadB);
}

function openThread(session: SessionSummary, slot: "a" | "b") {
  const other = slot === "a" ? "b" : "a";
  if (slotState[other]() === session.sessionId) emptySlot(other);
  disposeThread[slot]();
  setSlot(slot, session.sessionId);
  main.classList.toggle("b-empty", !state.threadB);
  disposeThread[slot] = thread(slots[slot], session, {
    close: () => {
      emptySlot(slot);
      markOpen();
    },
    swap: () => {
      const across = sessions.find((s) => s.sessionId === slotState[other]());
      openThread(session, other);
      if (across) openThread(across, slot);
      else emptySlot(slot);
    },
  });
  window.dispatchEvent(new Event("resize"));
  markOpen();
}

/** The open threads are highlighted in place; a redraw of the whole rail would jump the list. */
function markOpen() {
  for (const row of railCol.querySelectorAll<HTMLElement>(".thread")) {
    const id = row.dataset.session;
    row.classList.toggle("open", Boolean(id) && (id === state.threadA || id === state.threadB));
  }
}

/** ⌃Tab walks the threads in the order the rail shows them; ⌃⇧Tab walks back. */
function cycleThread(step: 1 | -1) {
  if (!sessions.length) return;
  const index = sessions.findIndex((s) => s.sessionId === state.threadA);
  const next = sessions[(index + step + sessions.length) % sessions.length];
  if (next) openThread(next, "a");
}

async function newThread(project?: string) {
  const title = await ask(project ? `New thread in ${project}` : "New thread");
  if (!title) return;
  const text = (await ask("First message")) ?? "";
  const result = await send("/task", { title, text, project });
  if (result.error) return alert(result.error);
  await refreshRail();
  const created = result.data as SessionSummary | undefined;
  if (created) openThread(created, "a");
}

// ---- the rail, the files column, the terminals -------------------------------------------

const refreshRail = () =>
  rail(railCol, { openThread, selectProject, newThread })
    .then(async () => {
      sessions = await allThreads(catalog);
      markOpen();
    })
    .catch(() => clear(railCol, unreachable()));

function selectProject(project: ProjectSummary | undefined) {
  const changed = state.project !== project?.slug;
  state.project = project?.slug;
  save();
  clear(
    filesCol,
    el(
      "header.panel-head",
      {},
      el("h2.ellipsis", {}, project ? project.slug : "Files"),
      el("span.grow"),
      project?.repo ? el("a.iconbtn", { href: project.repo, target: "_blank", rel: "noreferrer", title: project.repo }, icon("github", 13)) : undefined,
      project ? el("button.iconbtn", { title: "new terminal here", onclick: () => void terminals.open() }, icon("terminal", 13)) : undefined,
    ),
    el("div.tree-scroll", {}, project ? tree(project.path, openFile, () => state.file) : el("p.hint", {}, "Pick a project on the right to browse it.")),
  );
  if (changed) railCol.querySelectorAll(".group").forEach((g) => g.classList.toggle("selected", g.querySelector(".name")?.textContent === project?.slug));
}

const terminals = dock(dockPane, () => ({ slug: state.project, path: currentProject()?.path }));

// ---- the status bar: connection, cost, the quota rings, and the way to the other views ---

const ring = (percent: number, title: string) => {
  const r = 5.5;
  const c = 2 * Math.PI * r;
  const level = percent >= 90 ? "hot" : percent >= 70 ? "warm" : "cool";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 14 14");
  svg.setAttribute("class", `ring ${level}`);
  svg.innerHTML = `<circle cx="7" cy="7" r="${r}" class="track"/><circle cx="7" cy="7" r="${r}" class="fill" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - Math.min(100, percent) / 100)}" transform="rotate(-90 7 7)"/>`;
  return el("span.stat", { title }, svg, el("span", {}, `${percent}%`));
};

const statusLeft = el("div.status-left");
const statusRight = el("div.status-right");
const connection = el("span.conn", { title: "connection" });
const navButton = (name: IconName, label: string, onclick: () => void) => el("button.iconbtn.slim", { title: label, onclick }, icon(name, 13));
clear(statusbar, statusLeft, statusRight);

async function refreshUsage() {
  const stats: HTMLElement[] = [];
  try {
    const data = await usage();
    stats.push(el("span.stat", { title: "what the sessions have cost, as the SDK reports it" }, `$${data.costUsd.toFixed(2)}`));
    for (const window of data.windows)
      stats.push(ring(window.percent, `${window.name} · ${window.percent}% used · resets in ${until(window.resetsAt)}`));
    const session = data.windows.find((w) => w.name === "Session");
    if (session) stats.push(el("span.stat.dim", { title: "time left in the five-hour window" }, until(session.resetsAt)));
    if (!data.windows.length) stats.push(el("span.stat.dim", { title: data.error ?? "" }, "no quota"));
  } catch {
    stats.push(el("span.stat.dim", {}, "offline"));
  }
  clear(statusLeft, connection, ...stats);
}

function renderStatusRight(editorUrl?: string) {
  clear(
    statusRight,
    el("span.stat.dim", { title: `daemon at ${baseUrl()}` }, baseUrl().replace(/^https?:\/\//, "")),
    navButton("zap", "Search everything (⌘K)", openPalette),
    navButton("layout", "Dashboard", showDashboard),
    navButton("code", "Editor", showEditor),
    editorUrl ? el("a.iconbtn.slim", { title: "VS Code in the browser", href: editorUrl, target: "_blank", rel: "noreferrer" }, icon("external", 13)) : undefined,
    navButton("settings", "Settings", showSettings),
  );
}

function unreachable() {
  return el(
    "div.notice",
    {},
    el("p", {}, `Cannot reach ${baseUrl()}.`),
    lastError ? el("p.dim", {}, lastError) : undefined,
    el("div.row-inline", {}, el("button.btn", { onclick: () => void refreshAll() }, "Retry"), el("button.btn", { onclick: showSettings }, "Change address")),
  );
}

onConnection((online) => {
  const queued = outbox().length;
  connection.className = online ? "conn online" : "conn offline";
  connection.title = online ? (queued ? `online · ${queued} queued` : "online") : `offline${queued ? ` · ${queued} queued` : ""}`;
});

// ---- ⌘K --------------------------------------------------------------------------------

async function commands(): Promise<Command[]> {
  const actions: Command[] = [
    { id: "dashboard", title: "Dashboard", group: "view", icon: "layout", run: showDashboard },
    { id: "editor", title: "Editor", group: "view", icon: "code", run: showEditor },
    { id: "settings", title: "Settings", group: "view", icon: "settings", run: showSettings },
    { id: "new-thread", title: `New thread${state.project ? ` in ${state.project}` : ""}`, group: "action", icon: "message", run: () => void newThread(state.project) },
    { id: "new-terminal", title: `New terminal${state.project ? ` in ${state.project}` : ""}`, group: "action", icon: "terminal", run: () => void terminals.open() },
    { id: "add-project", title: "Add project", group: "action", icon: "plus", run: () => void addProjectDialog().then((added) => { if (added) void refreshAll(); }) },
    { id: "refresh", title: "Refresh threads and projects", group: "action", icon: "refresh", run: () => void refreshAll() },
    { id: "close-b", title: "Close the lower thread", group: "action", icon: "x", run: () => emptySlot("b") },
    ...(inDesktop ? [] : [{ id: "download", title: "Download the Mac app", group: "action", icon: "download" as IconName, run: () => window.open(DOWNLOAD) }]),
  ];
  const projectCommands = catalog.map<Command>((project) => ({ id: `project:${project.slug}`, title: project.slug, group: "project", hint: project.summary, run: () => selectProject(project) }));
  const threadCommands = sessions.map<Command>((session) => ({
    id: `thread:${session.sessionId}`,
    title: session.kind === "main" ? "assistant" : session.title || session.shortId,
    group: "thread",
    icon: session.kind === "claude" ? "terminal" : "message",
    hint: projectOf(session, catalog),
    run: () => openThread(session, "a"),
  }));
  const project = currentProject();
  const files = project ? await fileIndex(project.path).catch(() => []) : [];
  const fileCommands = files.map<Command>((path) => ({ id: `file:${path}`, title: path, group: "file", icon: "file", run: () => openFile(`${project!.path}/${path}`) }));
  return [...actions, ...projectCommands, ...threadCommands, ...fileCommands];
}
const openPalette = () => palette(commands);

document.addEventListener("keydown", (event) => {
  const meta = event.metaKey || event.ctrlKey;
  if (meta && event.key.toLowerCase() === "k") {
    event.preventDefault();
    openPalette();
  } else if (event.metaKey && event.key === "," && event.shiftKey === !inDesktop) {
    // ⌘, in the app; a browser keeps that one for itself, so ⌘⇧, on the web.
    event.preventDefault();
    showSettings();
  } else if (event.ctrlKey && event.key === "Tab") {
    event.preventDefault();
    cycleThread(event.shiftKey ? -1 : 1);
  }
});

// ---- boot --------------------------------------------------------------------------------

async function refreshAll() {
  try {
    catalog = await projects();
  } catch {
    catalog = [];
  }
  selectProject(catalog.find((p) => p.slug === state.project) ?? catalog[0]);
  await refreshRail();
  void terminals.refresh();
  void refreshUsage();
}

document.body.classList.toggle("desktop", inDesktop);
splits(main);
renderStatusRight();
emptyEditor(viewerPane);
emptySlot("a");
emptySlot("b");

void (async () => {
  await resolveBase();
  try {
    const health = await status();
    document.title = `pai · ${health.host.hostname}`;
    renderStatusRight(health.editor.url);
  } catch {
    /* offline is a normal way to start */
  }
  await refreshAll();
  if (state.file) openFile(state.file);
  for (const slot of ["a", "b"] as const) {
    const remembered = sessions.find((s) => s.sessionId === slotState[slot]());
    if (remembered) openThread(remembered, slot);
    else emptySlot(slot);
  }
  if (isOnline()) void flush();
  setInterval(() => void refreshUsage(), 60_000);
  // Session and terminal changes redraw the rail and the dock; the thread panes have streams of their own.
  follow(undefined, (event) => {
    if (event.kind.startsWith("session.started") || event.kind === "session.resumed" || event.kind === "session.turn_end" || event.kind === "session.exit" || event.kind === "task.created" || event.kind === "session.question")
      void refreshRail();
    if (event.kind.startsWith("terminal.")) void terminals.refresh();
  });
})();
