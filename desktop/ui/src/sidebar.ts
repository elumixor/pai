import { projects, tasks } from "./api.ts";
import { clear, el } from "./dom.ts";
import { tree } from "./files.ts";
import type { ProjectSummary, SessionSummary } from "./types.ts";

/** How many threads a project shows before its list starts scrolling. */
const VISIBLE_THREADS = 6;

export interface SidebarHandlers {
  readonly openThread: (session: SessionSummary) => void;
  readonly openFile: (path: string) => void;
  readonly openTerminal: (project?: string) => void;
}

const dot = (session: SessionSummary) => {
  if (session.waiting) return "dot waiting";
  if (session.state === "busy" || session.state === "starting") return "dot busy";
  if (session.state === "idle") return "dot idle";
  return "dot dead";
};

/** Threads grouped by the project they run in; the main conversation is its own group. */
function group(sessions: SessionSummary[], catalog: ProjectSummary[]) {
  const groups = new Map<string, SessionSummary[]>();
  const keyOf = (session: SessionSummary) => {
    if (session.kind === "main") return "main";
    if (session.project) return session.project;
    const match = catalog.find((project) => session.cwd?.startsWith(project.path));
    return match?.slug ?? "workspace";
  };
  for (const session of sessions) {
    const key = keyOf(session);
    groups.set(key, [...(groups.get(key) ?? []), session]);
  }
  return groups;
}

export async function sidebar(side: HTMLElement, handlers: SidebarHandlers) {
  const [{ live, recent }, catalog] = await Promise.all([tasks(), projects()]);
  const sessions = [...live, ...recent.filter((r) => !live.some((l) => l.shortId === r.shortId))];
  const groups = group(sessions, catalog);
  const files = el("div.files");

  const showFiles = (project: ProjectSummary | undefined) =>
    clear(
      files,
      el(
        "header.section",
        {},
        el("span.grow", {}, project ? project.slug : "files"),
        project ? el("button.ghost", { onclick: () => handlers.openTerminal(project.slug) }, "terminal") : el("span"),
      ),
      project ? tree(project.path, handlers.openFile) : el("p.empty", {}, "Pick a project to browse it."),
    );

  const rows: HTMLElement[] = [];
  for (const [key, threads] of [...groups].sort(([a], [b]) => (a === "main" ? -1 : b === "main" ? 1 : a.localeCompare(b)))) {
    const project = catalog.find((p) => p.slug === key);
    const list = el("div.threads", {
      style: threads.length > VISIBLE_THREADS ? `max-height:${VISIBLE_THREADS * 26}px;overflow-y:auto` : undefined,
    });
    for (const session of threads)
      list.append(
        el(
          "button.row.thread",
          { onclick: () => handlers.openThread(session) },
          el("span", { class: dot(session) }),
          el("span.grow", {}, session.title || session.shortId),
        ),
      );
    rows.push(
      el(
        "div.group",
        {},
        el(
          "button.row.project",
          { onclick: () => showFiles(project) },
          el("span.grow", {}, key),
          el("span.count", {}, String(threads.length)),
        ),
        list,
      ),
    );
  }

  // Projects with no thread yet still need to be browsable.
  const quiet = catalog.filter((project) => !groups.has(project.slug));
  if (quiet.length)
    rows.push(
      el(
        "div.group",
        {},
        el("header.section", {}, "projects"),
        ...quiet.map((project) => el("button.row.project", { onclick: () => showFiles(project) }, el("span.grow", {}, project.slug))),
      ),
    );

  clear(side, el("div.groups", {}, el("header.section", {}, "threads"), ...rows), files);
  showFiles(undefined);
}
