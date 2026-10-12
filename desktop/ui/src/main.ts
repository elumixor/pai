import { asks, baseUrl, fileIndex, flush, follow, inDesktop, isOnline, lastError, onConnection, outbox, projects, resolveBase, send, status, usage } from "./api.ts";
import { clear, el, sheet } from "./dom.ts";
import "./theme.ts";
import { editor, emptyEditor } from "./editor.ts";
import { current as currentRoute, navigate, onRoute, type Route } from "./router.ts";
import { home as homeView, type Centre } from "./home.ts";
import { nav } from "./nav.ts";
import { usageStats } from "./rings.ts";
import { tree, type Tree } from "./files.ts";
import { icon, type IconName } from "./icons.ts";
import { palette, type Command } from "./palette.ts";
import { addProjectDialog, allThreads, projectOf, rail } from "./rail.ts";
import { DOWNLOAD, settingsView, SHORTCUTS, type SettingsSection } from "./settings.ts";
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
// ---- the two views: home (the chat, the board) and work (the editor); settings over either ---

const homeRoot = $("home");
let homePage: ReturnType<typeof homeView> | undefined;
type View = "home" | "work";
function showView(next: View) {
  main.hidden = next !== "work";
  homeRoot.hidden = next !== "home";
  document.body.classList.toggle("in-home", next === "home");
  if (next === "home") homePage ??= homeView(homeRoot);
  else window.dispatchEvent(new Event("resize"));
}
const SETTINGS_ROUTES: readonly Route["name"][] = ["settings", "agents", "modules", "automations", "projects", "context"];
const showSettings = (section?: SettingsSection) => {
  if (document.querySelector("dialog.settings")) return;
  const { body, close } = sheet("settings");
  const dispose = settingsView(
    body,
    section,
    () => {
      dispose();
      close();
      if (SETTINGS_ROUTES.includes(currentRoute().name)) history.back();
    },
    {
      openFile: (path) => {
        navigate("editor");
        openFile(path);
      },
      selectProject: (slug) => {
        navigate("editor");
        const project = catalog.find((p) => p.slug === slug);
        if (project) selectProject(project);
      },
    },
  );
};
const showEditor = () => (state.file ? openFile(state.file) : emptyEditor(viewerPane));

/** Each address is one of the views: the chat, an agent's thread or the board at home; the editor; the settings sheet (and its pages about the daemon) over whatever is open. */
function applyRoute(route: Route) {
  // The dashboard's overview is gone: the chat is the front page now.
  if (route.name === "dashboard") return navigate("home", true);
  if (route.name === "settings") return showSettings();
  if (route.name === "agents" || route.name === "modules" || route.name === "automations" || route.name === "projects" || route.name === "context") {
    if (homeRoot.hidden && main.hidden) showView("home");
    return showSettings(route.name);
  }
  if (route.name === "editor") {
    showView("work");
    showEditor();
    // `editor/<session>`: that thread, in the first pane unless it is open already.
    const session = route.param ? sessions.find((s) => s.sessionId === route.param || s.shortId === route.param) : undefined;
    if (session && state.threadA !== session.sessionId && state.threadB !== session.sessionId) openThread(session, "a");
    return;
  }
  if (route.name === "home" || route.name === "board" || route.name === "chat" || route.name === "task") {
    showView("home");
    const centre: Centre =
      route.name === "home" ? { kind: "chat" } : route.name === "board" ? { kind: "board", slug: route.param } : route.name === "task" ? { kind: "task", id: Number(route.param) } : { kind: "agent", slug: route.param! };
    homePage!.show(centre);
  }
}
onRoute(applyRoute);

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

const statusLeft = el("div.status-left");
const statusRight = el("div.status-right");
const connection = el("span.conn", { title: "connection" });
const navButton = (name: IconName, label: string, onclick: () => void) => el("button.iconbtn.slim", { title: label, onclick }, icon(name, 13));
clear(statusbar, statusLeft, statusRight);

async function refreshUsage() {
  let stats: HTMLElement[];
  try {
    stats = usageStats(await usage());
  } catch {
    stats = [el("span.stat.dim", {}, "offline")];
  }
  clear(statusLeft, connection, ...stats);
}

function renderStatusRight(editorUrl?: string) {
  clear(
    statusRight,
    el("span.stat.dim", { title: `daemon at ${baseUrl()}` }, baseUrl().replace(/^https?:\/\//, "")),
    navButton("zap", "Search everything (⌘K)", openPalette),
    navButton("message", "The chat (⌘1)", () => navigate("home")),
    staffButton,
    navButton("code", "Editor (⌘3)", () => navigate("editor")),
    navButton("layout", "Modules (⌘4)", () => navigate("modules")),
    editorUrl ? el("a.iconbtn.slim", { title: "VS Code in the browser", href: editorUrl, target: "_blank", rel: "noreferrer" }, icon("external", 13)) : undefined,
    navButton("settings", "Settings", () => navigate("settings")),
  );
}

/** The way to the staff, with how many questions the agents are waiting on you for. */
const asksBadge = el("span.badge.ask", { hidden: true });
const staffButton = el("button.iconbtn.slim.staff-nav", { title: "Board (⌘2)", onclick: () => navigate("board") }, icon("board", 13), asksBadge);
async function refreshAsks() {
  const open = await asks().catch(() => []);
  asksBadge.textContent = String(open.length);
  asksBadge.hidden = !open.length;
  staffButton.title = open.length ? `Board (⌘2) · ${open.length} question${open.length === 1 ? "" : "s"} for you` : "Board (⌘2)";
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
    { id: "home", title: "Chat with pai", group: "view", icon: "message", hint: "the main chat", run: () => navigate("home") },
    { id: "board", title: "Board", group: "view", icon: "board", hint: "the agents' tasks, a kanban per project", run: () => navigate("board") },
    { id: "agents", title: "Agents", group: "view", icon: "users", hint: "pai's staff, their chats, tasks and asks", run: () => navigate("agents") },
    { id: "modules", title: "Modules", group: "view", icon: "zap", run: () => navigate("modules") },
    { id: "automations", title: "Automations", group: "view", icon: "play", run: () => navigate("automations") },
    { id: "projects", title: "Projects", group: "view", icon: "folder", run: () => navigate("projects") },
    { id: "context", title: "Context", group: "view", icon: "book", run: () => navigate("context") },
    { id: "editor", title: "Editor", group: "view", icon: "code", hint: "files, threads, terminals", run: () => navigate("editor") },
    { id: "settings", title: "Settings", group: "view", icon: "settings", run: () => navigate("settings") },
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
    title: session.title || session.shortId,
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
  } else if (meta && (event.key === "1" || event.key === "2" || event.key === "3" || event.key === "4")) {
    event.preventDefault();
    navigate(event.key === "1" ? "home" : event.key === "2" ? "board" : event.key === "3" ? "editor" : "modules");
  } else if (event.metaKey && event.key === "," && event.shiftKey === !inDesktop) {
    // ⌘, in the app; a browser keeps that one for itself, so ⌘⇧, on the web.
    event.preventDefault();
    navigate("settings");
  } else if (event.ctrlKey && event.key === "Tab") {
    event.preventDefault();
    cycleThread(event.shiftKey ? -1 : 1);
  } else if (event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === "l" && !homeRoot.hidden) {
    event.preventDefault();
    homePage?.focus();
  } else if (event.ctrlKey && !event.metaKey && !event.altKey && FOCUS[event.key.toLowerCase()]) {
    event.preventDefault();
    navigate("editor");
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
  void refreshAsks();
}

document.body.classList.toggle("desktop", inDesktop);
nav($("nav"));
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
  applyRoute(currentRoute());
  if (state.file && !main.hidden) openFile(state.file);
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
    if (event.kind === "ask.created" || event.kind === "ask.answered") void refreshAsks();
  });
})();
