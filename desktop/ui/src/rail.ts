import { addProject, projects, tasks, threadsIn } from "./api.ts";
import { clear, dialog, el } from "./dom.ts";
import { icon } from "./icons.ts";
import { save, state } from "./state.ts";
import type { DiskSession, ProjectSummary, SessionSummary } from "./types.ts";

/** How many threads a project shows before its list starts scrolling. */
const VISIBLE_THREADS = 8;

export interface RailHandlers {
  /** `slot` is where the thread opens: the top pane, or the one below it. */
  readonly openThread: (session: SessionSummary, slot: "a" | "b") => void;
  readonly selectProject: (project: ProjectSummary | undefined) => void;
  readonly newThread: (project?: string) => void;
}

const stateClass = (session: SessionSummary) => {
  if (session.waiting) return "waiting";
  if (session.state === "busy" || session.state === "starting") return "busy";
  if (session.state === "idle") return "idle";
  return "dead";
};

/** The project a session belongs to: the one it was started in, or the one whose directory holds its cwd. */
export const projectOf = (session: SessionSummary, catalog: ProjectSummary[]) =>
  session.project ?? catalog.find((project) => session.cwd === project.path || session.cwd?.startsWith(`${project.path}/`))?.slug ?? "workspace";

/** Threads grouped by project. The main conversation runs in the workspace inside the pai checkout, so it lands there. */
function group(sessions: SessionSummary[], catalog: ProjectSummary[]) {
  const groups = new Map<string, SessionSummary[]>();
  for (const session of sessions) {
    const key = projectOf(session, catalog);
    groups.set(key, [...(groups.get(key) ?? []), session]);
  }
  return groups;
}

const isOpen = (session: SessionSummary) => state.threadA === session.sessionId || state.threadB === session.sessionId;

const fromDisk = (found: DiskSession): SessionSummary => ({
  sessionId: found.sessionId,
  shortId: found.sessionId.slice(0, 6),
  kind: "claude",
  title: found.title,
  state: "detached",
  cwd: found.cwd,
  lastActivity: found.lastActivity,
});

const activity = (session: SessionSummary) => {
  if (session.kind === "main") return Number.MAX_SAFE_INTEGER;
  if (session.state === "busy" || session.state === "starting" || session.waiting) return Number.MAX_SAFE_INTEGER - 1;
  return session.lastActivity ? new Date(session.lastActivity).getTime() : 0;
};

/**
 * Everything the daemon knows plus every conversation on disk under a project, terminal
 * ones included: the ones `claude` was started with are threads here too.
 */
export async function allThreads(catalog: ProjectSummary[]) {
  const [{ live, recent }, ...onDisk] = await Promise.all([tasks(), ...catalog.map((project) => threadsIn(project.path).catch(() => []))]);
  const known = [...live, ...recent.filter((r) => !live.some((l) => l.sessionId === r.sessionId))];
  const seen = new Set(known.map((s) => s.sessionId));
  const extra = onDisk.flat().filter((found) => !seen.has(found.sessionId)).map(fromDisk);
  return [...known, ...extra].sort((a, b) => activity(b) - activity(a));
}

/** Asks for a repository to clone under devRoot and adds it. */
export async function addProjectDialog() {
  const answer = await dialog({
    title: "Add a project",
    description: "A project is a git checkout under ~/dev on the box. Paste the repository to clone — GitHub or anywhere git can reach.",
    fields: [
      { name: "url", label: "Repository", placeholder: "git@github.com:you/thing.git", required: true },
      { name: "name", label: "Directory", placeholder: "defaults to the repository's name" },
    ],
    submit: "Clone",
  });
  if (!answer?.url) return false;
  const result = await addProject(answer.url, answer.name || undefined);
  if (result.error) alert(result.error);
  else if (result.queued) alert("queued — the daemon is offline");
  return !result.error;
}

/**
 * The right-hand rail: every project with its threads under it, a GitHub link where there
 * is a repository, a way to start a thread in a project, and a way to add a project.
 */
export async function rail(root: HTMLElement, handlers: RailHandlers) {
  const catalog = await projects();
  const sessions = await allThreads(catalog);
  const groups = group(sessions, catalog);
  const keys = [...new Set([...catalog.map((p) => p.slug), ...groups.keys()])].sort((a, b) => a.localeCompare(b));

  const threadRow = (session: SessionSummary) =>
    el(
      "button.thread",
      {
        class: `thread${isOpen(session) ? " open" : ""}${session.kind === "main" ? " main" : ""}`,
        "data-session": session.sessionId,
        title: `${session.title || session.shortId}\nclick: open · shift+click: open in the lower pane`,
        onclick: (event: Event) => handlers.openThread(session, (event as MouseEvent).shiftKey ? "b" : "a"),
      },
      el("span", { class: `dot ${stateClass(session)}` }),
      el("span.label", {}, session.kind === "main" ? "assistant" : session.title || session.shortId),
      session.kind === "claude" ? icon("terminal", 11) : undefined,
    );

  const groupNode = (key: string) => {
    const project = catalog.find((p) => p.slug === key);
    const threads = groups.get(key) ?? [];
    const collapsed = state.collapsed.includes(key);
    const selected = project && state.project === project.slug;
    const list = el("div.threads", { hidden: collapsed, class: `threads${threads.length > VISIBLE_THREADS ? " long" : ""}` }, ...threads.map(threadRow));
    const toggle = el(
      "button.iconbtn.chev",
      {
        class: `iconbtn chev${collapsed ? " closed" : ""}`,
        title: collapsed ? "expand" : "collapse",
        onclick: (event: Event) => {
          event.stopPropagation();
          const now = list.hasAttribute("hidden");
          if (now) list.removeAttribute("hidden");
          else list.setAttribute("hidden", "");
          toggle.classList.toggle("closed", !now);
          state.collapsed = now ? state.collapsed.filter((k) => k !== key) : [...state.collapsed, key];
          save();
        },
      },
      icon("chevron", 13),
    );
    return el(
      "section.group",
      { class: `group${selected ? " selected" : ""}` },
      el(
        "header.group-head",
        {
          title: threads.length ? "open the latest thread" : "browse the files",
          onclick: () => {
            handlers.selectProject(project);
            if (threads[0]) handlers.openThread(threads[0], "a");
          },
        },
        project?.kind === "context" ? icon("book", 12) : undefined,
        el("span.name", {}, key),
        el("span.count", {}, threads.length ? String(threads.length) : ""),
        project
          ? el(
              "button.iconbtn",
              {
                title: `new thread in ${key}`,
                onclick: (event: Event) => {
                  event.stopPropagation();
                  handlers.newThread(project.slug);
                },
              },
              icon("plus", 13),
            )
          : undefined,
        project?.repo
          ? el("a.iconbtn", { href: project.repo, target: "_blank", rel: "noreferrer", title: project.repo, onclick: (e: Event) => e.stopPropagation() }, icon("github", 13))
          : undefined,
        toggle,
      ),
      list,
    );
  };

  const add = el(
    "button.add-project",
    {
      onclick: async () => {
        if (await addProjectDialog()) void rail(root, handlers);
      },
    },
    icon("plus", 14),
    el("span", {}, "Add project"),
  );

  // A redraw keeps the scroll where it was; otherwise every event would jump the list to the top.
  const scrolled = root.querySelector(".rail-scroll")?.scrollTop ?? 0;
  const scroller = el("div.rail-scroll", {}, ...keys.map(groupNode));
  clear(root, scroller, add);
  scroller.scrollTop = scrolled;
}
