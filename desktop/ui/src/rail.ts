import { addProject, projects, tasks } from "./api.ts";
import { ask, clear, el } from "./dom.ts";
import { icon } from "./icons.ts";
import { save, state } from "./state.ts";
import type { ProjectSummary, SessionSummary } from "./types.ts";

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

/** Threads grouped by the project they run in; the main conversation is its own group at the top. */
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

const isOpen = (session: SessionSummary) => state.threadA === session.shortId || state.threadB === session.shortId;

/**
 * The right-hand rail: every project with its threads under it, a GitHub link where there
 * is a repository, a way to start a thread in a project, and a way to add a project.
 */
export async function rail(root: HTMLElement, handlers: RailHandlers) {
  const [{ live, recent }, catalog] = await Promise.all([tasks(), projects()]);
  const sessions = [...live, ...recent.filter((r) => !live.some((l) => l.shortId === r.shortId))];
  const groups = group(sessions, catalog);
  const keys = [...new Set([...groups.keys(), ...catalog.map((p) => p.slug)])].sort((a, b) =>
    a === "main" ? -1 : b === "main" ? 1 : a.localeCompare(b),
  );

  const threadRow = (session: SessionSummary) =>
    el(
      "button.thread",
      {
        class: `thread${isOpen(session) ? " open" : ""}`,
        title: `${session.title || session.shortId}\nclick: open above · shift+click: open below`,
        onclick: (event: Event) => handlers.openThread(session, (event as MouseEvent).shiftKey ? "b" : "a"),
      },
      el("span", { class: `dot ${stateClass(session)}` }),
      el("span.label", {}, session.title || session.shortId),
      session.waiting ? el("span.tag", {}, "?") : undefined,
    );

  const groupNode = (key: string) => {
    const project = catalog.find((p) => p.slug === key);
    const threads = groups.get(key) ?? [];
    const collapsed = state.collapsed.includes(key);
    const selected = project && state.project === project.slug;
    const list = el("div.threads", { hidden: collapsed }, ...threads.map(threadRow));
    if (!threads.length && !collapsed && key === "main") list.append(el("p.hint", {}, "no conversation yet"));
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
      icon("chevron", 14),
    );
    return el(
      "section.group",
      { class: `group${selected ? " selected" : ""}` },
      el(
        "header.group-head",
        { onclick: () => handlers.selectProject(project) },
        key === "main" ? icon("bot", 14) : icon("folder", 14),
        el("span.name", {}, key === "main" ? "pai" : key),
        el("span.count", {}, threads.length ? String(threads.length) : ""),
        key === "main"
          ? undefined
          : el(
              "button.iconbtn",
              {
                title: `new thread in ${key}`,
                onclick: (event: Event) => {
                  event.stopPropagation();
                  handlers.newThread(project?.slug);
                },
              },
              icon("plus", 14),
            ),
        project?.repo
          ? el("a.iconbtn", { href: project.repo, target: "_blank", rel: "noreferrer", title: project.repo, onclick: (e: Event) => e.stopPropagation() }, icon("github", 14))
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
        const url = await ask("git url to clone under ~/dev");
        if (!url) return;
        add.classList.add("busy");
        const result = await addProject(url);
        add.classList.remove("busy");
        if (result.error) alert(result.error);
        else if (result.queued) alert("queued — the daemon is offline");
        else void rail(root, handlers);
      },
    },
    icon("plus", 15),
    el("span", {}, "Add project"),
  );

  clear(root, el("div.rail-scroll", {}, ...keys.map(groupNode)), add);
}
