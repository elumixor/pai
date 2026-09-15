import { baseUrl, flush, follow, inDesktop, isOnline, lastError, onConnection, outbox, projects, resolveBase, send, status, tasks, usage } from "./api.ts";
import { dashboard } from "./dashboard.ts";
import { ask, clear, el, until } from "./dom.ts";
import { emptyViewer, tree, viewer } from "./files.ts";
import { icon, type IconName } from "./icons.ts";
import { rail } from "./rail.ts";
import { settingsView } from "./settings.ts";
import { splits } from "./splits.ts";
import { save, state } from "./state.ts";
import { dock } from "./terminals.ts";
import { thread } from "./thread.ts";
import type { ProjectSummary, SessionSummary } from "./types.ts";

const DOWNLOAD = "https://github.com/elumixor/pai/releases/latest/download/pai-macos.dmg";

const $ = (id: string) => document.getElementById(id)!;
const main = $("main");
const filesCol = $("files");
const viewerPane = $("viewer");
const dockPane = $("dock");
const slots = { a: $("thread-a"), b: $("thread-b") } as const;
const railCol = $("rail");
const nav = $("nav");
const topRight = $("top-right");
const stateBadge = $("state");

let catalog: ProjectSummary[] = [];
let sessions: SessionSummary[] = [];
const currentProject = () => catalog.find((p) => p.slug === state.project);

// ---- the centre pane: dashboard, settings, or a file -------------------------------------

let disposeCenter: () => void = () => {};
const showCenter = async (open: () => Promise<(() => void) | void> | (() => void) | void) => {
  disposeCenter();
  disposeCenter = (await open()) ?? (() => {});
};
const openFile = (path: string) => {
  state.file = path;
  save();
  void showCenter(() => viewer(viewerPane, path));
};

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
  clear(
    slots[slot],
    el(
      "div.empty",
      {},
      icon("message", 24),
      el("p", {}, slot === "a" ? "Pick a thread on the right." : "Shift-click a thread to open it here."),
      slot === "a" ? el("button.btn", { onclick: () => newThread(state.project) }, "New thread") : undefined,
    ),
  );
  main.classList.toggle("b-empty", !state.threadB);
}

function openThread(session: SessionSummary, slot: "a" | "b") {
  const other = slot === "a" ? "b" : "a";
  if (slotState[other]() === session.shortId) emptySlot(other);
  disposeThread[slot]();
  setSlot(slot, session.shortId);
  main.classList.toggle("b-empty", !state.threadB);
  disposeThread[slot] = thread(slots[slot], session, {
    close: () => {
      emptySlot(slot);
      refreshRail();
    },
    swap: () => {
      const across = sessions.find((s) => s.shortId === slotState[other]());
      openThread(session, other);
      if (across) openThread(across, slot);
      else emptySlot(slot);
      refreshRail();
    },
  });
  window.dispatchEvent(new Event("resize"));
  refreshRail();
}

async function newThread(project?: string) {
  const title = await ask(project ? `Thread title (in ${project})` : "Thread title");
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
      const { live, recent } = await tasks();
      sessions = [...live, ...recent.filter((r) => !live.some((l) => l.shortId === r.shortId))];
    })
    .catch(() => clear(railCol, unreachable()));

function selectProject(project: ProjectSummary | undefined) {
  state.project = project?.slug;
  save();
  clear(
    filesCol,
    el(
      "header.panel-head",
      {},
      icon("folder", 14),
      el("h2.ellipsis", {}, project ? project.slug : "Files"),
      el("span.grow"),
      project?.repo ? el("a.iconbtn", { href: project.repo, target: "_blank", rel: "noreferrer", title: project.repo }, icon("github", 14)) : undefined,
    ),
    el("div.tree-scroll", {}, project ? tree(project.path, openFile, () => state.file) : el("p.hint", {}, "Pick a project on the right to browse it.")),
    statusLine,
  );
  refreshRail();
}

const terminals = dock(dockPane, () => ({ slug: state.project, path: currentProject()?.path }));

// ---- the status line: cost, quota, time left in the session window -----------------------

const statusLine = el("footer.status-line");
async function refreshUsage() {
  try {
    const data = await usage();
    const session = data.windows.find((w) => w.name === "Session");
    const weekly = data.windows.find((w) => w.name !== "Session");
    const level = (percent: number) => (percent >= 90 ? "hot" : percent >= 70 ? "warm" : "cool");
    clear(
      statusLine,
      el("span.stat", { title: "what the sessions have cost, as the SDK reports it" }, `$${data.costUsd.toFixed(2)}`),
      session ? el("span.stat", { class: `stat ${level(session.percent)}`, title: `session window · resets in ${until(session.resetsAt)}` }, `${session.percent}%`) : undefined,
      session ? el("span.stat", { title: "time left in the five-hour session window" }, until(session.resetsAt)) : undefined,
      weekly ? el("span.stat.dim", { class: `stat dim ${level(weekly.percent)}`, title: `${weekly.name} weekly · resets in ${until(weekly.resetsAt)}` }, `wk ${weekly.percent}%`) : undefined,
      !data.windows.length ? el("span.stat.dim", { title: data.error ?? "" }, "no quota") : undefined,
    );
  } catch {
    clear(statusLine, el("span.stat.dim", {}, "offline"));
  }
}

// ---- top bar -----------------------------------------------------------------------------

const navButton = (name: IconName, label: string, onclick: () => void) => el("button.navbtn", { title: label, onclick }, icon(name, 16), el("span", {}, label));
const navLink = (name: IconName, label: string, href: string) => el("a.navbtn", { title: label, href, target: "_blank", rel: "noreferrer" }, icon(name, 16), el("span", {}, label));

function renderNav(editorUrl?: string) {
  clear(
    nav,
    navButton("layout", "Dashboard", () => void showCenter(() => dashboard(viewerPane))),
    navButton("code", "Editor", () => (state.file ? openFile(state.file) : emptyViewer(viewerPane))),
    editorUrl ? navLink("external", "VS Code", editorUrl) : undefined,
    navButton("settings", "Settings", () => void showCenter(() => settingsView(viewerPane))),
  );
  clear(
    topRight,
    inDesktop ? undefined : el("a.navbtn.subtle", { href: DOWNLOAD, title: "the desktop app for macOS" }, icon("download", 15), el("span", {}, "Mac app")),
    el("button.iconbtn", { title: "refresh", onclick: () => void refreshAll() }, icon("refresh", 15)),
  );
}

function unreachable() {
  return el(
    "div.notice",
    {},
    el("p", {}, `Cannot reach ${baseUrl()}.`),
    lastError ? el("p.dim", {}, lastError) : undefined,
    el("div.row-inline", {}, el("button.btn", { onclick: () => void refreshAll() }, "Retry"), el("button.btn", { onclick: () => void showCenter(() => settingsView(viewerPane)) }, "Change address")),
  );
}

onConnection((online) => {
  const queued = outbox().length;
  stateBadge.className = online ? "state online" : "state offline";
  stateBadge.textContent = online ? (queued ? `online · ${queued} queued` : "online") : `offline${queued ? ` · ${queued} queued` : ""}`;
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
renderNav();
emptyViewer(viewerPane);
emptySlot("a");
emptySlot("b");

void (async () => {
  await resolveBase();
  try {
    const health = await status();
    document.title = `pai · ${health.host.hostname}`;
    renderNav(health.editor.url);
  } catch {
    /* offline is a normal way to start */
  }
  await refreshAll();
  if (state.file) openFile(state.file);
  for (const slot of ["a", "b"] as const) {
    const remembered = sessions.find((s) => s.shortId === slotState[slot]());
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
