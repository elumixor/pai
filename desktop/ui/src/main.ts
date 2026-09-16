import { baseUrl, fileIndex, flush, follow, inDesktop, isOnline, lastError, onConnection, outbox, projects, resolveBase, send, status, usage } from "./api.ts";
import { dashboard } from "./dashboard.ts";
import { ago, clear, el, sheet, until } from "./dom.ts";
import "./theme.ts";
import { editor, emptyEditor } from "./editor.ts";
import { tree, type Tree } from "./files.ts";
import { icon, type IconName } from "./icons.ts";
import { palette, type Command } from "./palette.ts";
import { addProjectDialog, allThreads, projectOf, rail } from "./rail.ts";
import { DOWNLOAD, settingsView, SHORTCUTS, type SettingsSection } from "./settings.ts";
import { prefs } from "./prefs.ts";
import { choose } from "./theme.ts";
import { THEMES } from "./themes.ts";
import { composeOf } from "./thread.ts";
import { splits } from "./splits.ts";
import { save, state } from "./state.ts";
import { dock } from "./terminals.ts";
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
// ---- the two views: work and dashboard ---------------------------------------------------

const dashboardRoot = $("dashboard");
let dashboardView: ReturnType<typeof dashboard> | undefined;
let view: "work" | "dashboard" = "work";
function showView(next: "work" | "dashboard") {
  view = next;
  main.hidden = next !== "work";
  dashboardRoot.hidden = next !== "dashboard";
  document.body.classList.toggle("in-dashboard", next === "dashboard");
  if (next === "dashboard") {
    dashboardView ??= dashboard(dashboardRoot, {
      openFile: (path) => {
        showView("work");
        openFile(path);
      },
      selectProject: (slug) => {
        showView("work");
        const project = catalog.find((p) => p.slug === slug);
        if (project) selectProject(project);
      },
    });
    void dashboardView.show("overview");
  } else window.dispatchEvent(new Event("resize"));
}
const showDashboard = () => showView(view === "dashboard" ? "work" : "dashboard");
const showSettings = (section?: SettingsSection) => {
  if (document.querySelector("dialog.settings")) return;
  const { body, close } = sheet("settings");
  settingsView(body, section, close);
};
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
    projectPath: () => catalog.find((p) => p.slug === projectOf(session, catalog))?.path ?? currentProject()?.path,
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

/** Starts a thread straight away; it takes its name from the first message. */
async function newThread(project?: string) {
  const result = await send("/task", { title: "", text: "", project });
  if (result.error) return alert(result.error);
  await refreshRail();
  const created = result.data as SessionSummary | undefined;
  if (created) {
    openThread(created, "a");
    composeOf(slots.a)?.focus();
  }
}

// ---- the rail, the files column, the terminals -------------------------------------------

const refreshRail = () =>
  rail(railCol, { openThread, selectProject, newThread })
    .then(async () => {
      sessions = await allThreads(catalog);
      markOpen();
    })
    .catch(() => clear(railCol, unreachable()));

let fileTree: Tree | undefined;

function selectProject(project: ProjectSummary | undefined) {
  const changed = state.project !== project?.slug;
  state.project = project?.slug;
  save();
  fileTree = project ? tree(project.path, openFile, () => state.file) : undefined;
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
    el("div.tree-scroll", {}, fileTree ?? el("p.hint", {}, "Pick a project on the right to browse it.")),
  );
  if (changed) railCol.querySelectorAll(".group").forEach((g) => g.classList.toggle("selected", g.querySelector(".name")?.textContent === project?.slug));
}

const terminals = dock(dockPane, () => ({ slug: state.project, path: currentProject()?.path }));

// ---- the status bar: connection, cost, the quota rings, and the way to the other views ---

const ring = (window: { name: string; percent: number; resetsAt?: string; length: number }, source?: string) => {
  const { percent } = window;
  const r = 5.5;
  const c = 2 * Math.PI * r;
  const level = percent >= 90 ? "hot" : percent >= 70 ? "warm" : "cool";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 14 14");
  svg.setAttribute("class", `ring ${level}`);
  svg.innerHTML = `<circle cx="7" cy="7" r="${r}" class="track"/><circle cx="7" cy="7" r="${r}" class="fill" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - Math.min(100, percent) / 100)}" transform="rotate(-90 7 7)"/>`;
  const stat = el("span.stat.has-tip", {}, svg, el("span", {}, `${percent}%`));
  stat.addEventListener("mouseenter", () => {
    const left = window.resetsAt ? Math.max(0, new Date(window.resetsAt).getTime() - Date.now()) / 1000 : 0;
    const elapsed = window.length ? Math.round(100 - (left / window.length) * 100) : 0;
    showTip(stat, [
      el("strong", {}, window.name),
      el("span", {}, `${percent}% of the limit used`),
      window.resetsAt ? el("span", {}, `resets in ${until(window.resetsAt)} · ${elapsed}% of the ${window.length >= 86400 ? "week" : "window"} elapsed`) : undefined,
      source ? el("span.dim", {}, source) : undefined,
      el("span.dim", {}, "which rings show: settings → usage rings"),
    ]);
  });
  stat.addEventListener("mouseleave", hideTip);
  return stat;
};

const tip = el("div.tooltip", { hidden: true });
document.body.append(tip);
function showTip(anchor: HTMLElement, lines: (HTMLElement | undefined)[]) {
  clear(tip, ...lines);
  tip.removeAttribute("hidden");
  const box = anchor.getBoundingClientRect();
  tip.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - tip.offsetWidth - 8))}px`;
  tip.style.top = `${box.top - tip.offsetHeight - 8}px`;
}
const hideTip = () => tip.setAttribute("hidden", "");

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
    const hidden = new Set(prefs().hiddenRings);
    const source = data.via ? `read on ${data.via} ${data.fetchedAt ? ago(data.fetchedAt) : ""}` : undefined;
    for (const window of data.windows) if (!hidden.has(window.name)) stats.push(ring(window, source));
    const session = data.windows.find((w) => w.name === "Session");
    if (session && !hidden.has("Session")) stats.push(el("span.stat.dim", { title: "time left in the five-hour window" }, until(session.resetsAt)));
    if (!data.windows.length) stats.push(el("span.stat.dim", { title: data.error ?? "" }, "no quota"));
    else if (data.error) stats.push(el("span.stat.dim", { title: data.error }, "stale"));
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
    navButton("layout", "Dashboard (⌘2) · Work (⌘1)", showDashboard),
    navButton("code", "Editor", showEditor),
    editorUrl ? el("a.iconbtn.slim", { title: "VS Code in the browser", href: editorUrl, target: "_blank", rel: "noreferrer" }, icon("external", 13)) : undefined,
    navButton("settings", "Settings", () => showSettings()),
  );
}

function unreachable() {
  return el(
    "div.notice",
    {},
    el("p", {}, `Cannot reach ${baseUrl()}.`),
    lastError ? el("p.dim", {}, lastError) : undefined,
    el("div.row-inline", {}, el("button.btn", { onclick: () => void refreshAll() }, "Retry"), el("button.btn", { onclick: () => showSettings("connection") }, "Change address")),
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
    { id: "dashboard", title: "Dashboard", group: "view", icon: "layout", run: () => showView("dashboard") },
    { id: "work", title: "Work view", group: "view", icon: "code", run: () => showView("work") },
    { id: "editor", title: "Editor", group: "view", icon: "code", run: () => (showView("work"), showEditor()) },
    { id: "settings", title: "Settings", group: "view", icon: "settings", run: () => showSettings() },
    { id: "new-thread", title: `New thread${state.project ? ` in ${state.project}` : ""}`, group: "action", icon: "message", run: () => void newThread(state.project) },
    { id: "new-terminal", title: `New terminal${state.project ? ` in ${state.project}` : ""}`, group: "action", icon: "terminal", run: () => void terminals.open() },
    { id: "add-project", title: "Add project", group: "action", icon: "plus", run: () => void addProjectDialog().then((added) => { if (added) void refreshAll(); }) },
    { id: "refresh", title: "Refresh threads and projects", group: "action", icon: "refresh", run: () => void refreshAll() },
    { id: "close-b", title: "Close the lower thread", group: "action", icon: "x", run: () => emptySlot("b") },
    ...(inDesktop ? [] : [{ id: "download", title: "Download the Mac app", group: "action", icon: "download" as IconName, run: () => window.open(DOWNLOAD) }]),
  ];
  const settingCommands: Command[] = [
    ...(["appearance", "usage", "shortcuts", "connection"] as SettingsSection[]).map<Command>((section) => ({ id: `settings:${section}`, title: `Settings: ${section}`, group: "settings", icon: "settings", run: () => showSettings(section) })),
    ...(["system", "light", "dark"] as const).map<Command>((mode) => ({ id: `mode:${mode}`, title: `Mode: ${mode}`, group: "settings", icon: mode === "dark" ? "moon" : mode === "light" ? "sun" : "monitor", run: () => choose({ mode }) })),
    ...THEMES.map<Command>((theme) => ({ id: `theme:${theme.id}`, title: `Theme: ${theme.name}`, group: "settings", icon: theme.kind === "dark" ? "moon" : "sun", hint: theme.kind, run: () => choose(theme.kind === "dark" ? { dark: theme.id, mode: "dark" } : { light: theme.id, mode: "light" }) })),
    ...SHORTCUTS.map<Command>((s) => ({ id: `key:${s.keys}`, title: `${s.keys} — ${s.what}`, group: "shortcut", icon: "key", run: () => showSettings("shortcuts") })),
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
  return [...actions, ...settingCommands, ...projectCommands, ...threadCommands, ...fileCommands];
}
const openPalette = () => palette(commands);

document.addEventListener("keydown", (event) => {
  const meta = event.metaKey || event.ctrlKey;
  if (meta && event.key.toLowerCase() === "k") {
    event.preventDefault();
    openPalette();
  } else if (meta && event.key.toLowerCase() === "f" && !event.shiftKey) {
    // ⌘F: the open file, found in the tree.
    event.preventDefault();
    if (state.file) void fileTree?.reveal(state.file);
  } else if (meta && (event.key === "1" || event.key === "2")) {
    event.preventDefault();
    showView(event.key === "1" ? "work" : "dashboard");
  } else if (event.metaKey && event.key === "," && event.shiftKey === !inDesktop) {
    // ⌘, in the app; a browser keeps that one for itself, so ⌘⇧, on the web.
    event.preventDefault();
    showSettings();
  } else if (event.ctrlKey && event.key === "Tab") {
    event.preventDefault();
    cycleThread(event.shiftKey ? -1 : 1);
  } else if (event.ctrlKey && !event.metaKey && !event.altKey && FOCUS[event.key.toLowerCase()]) {
    event.preventDefault();
    showView("work");
    FOCUS[event.key.toLowerCase()]!();
  }
});

/** ⌃J terminal, ⌃E editor, ⌃L the thread's message box, ⌃B the file tree, ⌃N a new thread. */
const FOCUS: Record<string, () => void> = {
  j: () => terminals.focus(),
  e: () => (viewerPane.querySelector<HTMLElement>(".cm-content") ?? viewerPane).focus(),
  l: () => composeOf(slots.a)?.focus(),
  b: () => filesCol.querySelector<HTMLElement>(".file")?.focus(),
  n: () => void newThread(state.project),
};

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
  window.addEventListener("pai:prefs", () => void refreshUsage());
  // Session and terminal changes redraw the rail and the dock; the thread panes have streams of their own.
  follow(undefined, (event) => {
    if (event.kind.startsWith("session.started") || event.kind === "session.resumed" || event.kind === "session.turn_end" || event.kind === "session.exit" || event.kind === "task.created" || event.kind === "session.question")
      void refreshRail();
    if (event.kind.startsWith("terminal.")) void terminals.refresh();
  });
})();
