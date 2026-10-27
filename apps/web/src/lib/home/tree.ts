import { basename, modelName } from "../format";
import type { IconName } from "../icons";
import type { Agent, AgentStatus, AgentThread, Need, ProjectSummary, TaskItem, TaskStatus } from "../types";

/**
 * The tree on the left: General, under it the agents (each under the one it reports to), under each its open tasks,
 * its sub-agents and the threads it is running; code threads under Dev, a folder per project; and whatever runs for
 * General itself. A thread that is not running is not there: ⌘K finds it, and a message brings it back.
 */
export interface TreeRow {
  readonly id: string;
  readonly label: string;
  readonly depth: number;
  /** A thread: it comes and goes with its work, and leaves with a check. */
  readonly thread?: boolean;
  readonly working: boolean;
  /** How many decisions wait on him in this row. */
  readonly waiting: number;
  readonly on: boolean;
  readonly title?: string;
  readonly icon: IconName;
  /** A row that cannot be opened: a folder that only groups the rows under it. */
  readonly inert?: boolean;
  /** A thread that just finished: a check for a moment before it leaves. */
  readonly done?: boolean;
}

/** What the centre shows, which decides the row that is on. */
export type Centre = { kind: "chat" } | { kind: "agent"; slug: string } | { kind: "project"; slug: string } | { kind: "task"; id: number } | { kind: "thread"; id: string } | { kind: "board"; slug?: string };

export const PAI = "pai";
const STATUS: Record<AgentStatus, string> = { working: "working", waiting: "waiting on you", queued: "queued", idle: "idle", closed: "closed" };
export const KIND_ORDER: Record<Agent["kind"], number> = { orchestrator: 0, standing: 1, service: 2, sub: 3 };
const KIND_ICON: Record<Agent["kind"], IconName> = { orchestrator: "home", standing: "bot", service: "zap", sub: "branch" };
/** An agent's icon from what it is called: the first that fits. */
const AGENT_ICONS: readonly (readonly [RegExp, IconName])[] = [
  [/\b(dev|code|coder|build|engineer)/i, "code"],
  [/hir|recruit|people|team|candidate/i, "users"],
  [/search|find|scout|research/i, "search"],
  [/admin|ops|office|paper/i, "wrench"],
  [/balance|calendar|plan|schedul/i, "calendar"],
  [/mail|inbox/i, "mail"],
  [/budget|financ|invoice|money|account/i, "list"],
  [/voice|speak/i, "message"],
];
/** The agent code threads are listed under; without one, a folder of that name. */
export const DEV_SLUGS = ["dev", "pai-dev"];
export const DEV_LABEL = "Dev";
/** Where a thread was started, as a row says it and the icon it is drawn with. */
export const ORIGIN: Record<string, readonly [string, IconName]> = {
  general: ["General", "message"],
  cli: ["CLI", "terminal"],
  terminal: ["Terminal", "terminal"],
  phone: ["Phone", "send"],
  builder: ["Builder", "code"],
  routine: ["Routine", "clock"],
  agent: ["", "bot"],
};
export const TASK_ICON: Record<TaskStatus, IconName> = { waiting_user: "hand", active: "play", inbox: "circle", scheduled: "clock", waiting_other: "hourglass", done: "circleCheck", dropped: "x" };
const TASK_ORDER: readonly TaskStatus[] = ["waiting_user", "active", "waiting_other", "inbox", "scheduled"];

export const agentIcon = (a: Agent): IconName => AGENT_ICONS.find(([re]) => re.test(`${a.slug} ${a.name}`))?.[1] ?? KIND_ICON[a.kind];
/** A thread of Claude Code in a repo: it is listed under Dev, in its project's folder. */
export const isCode = (t: AgentThread) => t.kind === "code" || Boolean(t.project);
export const projectName = (t: AgentThread) => t.project ?? (t.cwd ? basename(t.cwd) : "");
/** How a thread was started; a daemon that does not say: a project means Claude Code in its folder, else an agent. */
export const originOf = (t: AgentThread) => t.origin ?? (t.project || t.kind === "code" ? "terminal" : "agent");

export interface TreeState {
  readonly agents: readonly Agent[];
  readonly tasks: readonly TaskItem[];
  readonly needs: readonly Need[];
  readonly projects: readonly ProjectSummary[];
  readonly centre: Centre;
  /** The task open in the centre, closed ones included. */
  readonly openTask?: TaskItem;
}

/** A thread by its session id, with the agent it is listed under. */
export function threadOf(agents: readonly Agent[], id: string): { thread: AgentThread; owner: Agent } | undefined {
  for (const a of agents) {
    const thread = a.threads?.find((t) => t.sessionId === id || t.shortId === id);
    if (thread) return { thread, owner: a };
  }
  return undefined;
}

export const devAgent = (agents: readonly Agent[]) => agents.find((a) => DEV_SLUGS.includes(a.slug) && a.status !== "closed");

/** The agent whose row is on: the open page's, a task's owner, a thread's. */
export function selectedSlug(s: TreeState) {
  const c = s.centre;
  if (c.kind === "agent") return c.slug;
  if (c.kind === "project") return devAgent(s.agents)?.slug ?? PAI;
  if (c.kind === "board") return c.slug ?? PAI;
  if (c.kind === "task") return s.openTask?.owner ?? PAI;
  if (c.kind === "thread") return threadOf(s.agents, c.id)?.owner.slug ?? PAI;
  return PAI;
}

export function treeRows(s: TreeState): TreeRow[] {
  const { agents, tasks, needs, projects, centre } = s;
  const bySlug = (slug: string) => agents.find((a) => a.slug === slug);
  const selected = selectedSlug(s);
  const shown = (a: Agent) => a.slug !== PAI && (a.status !== "closed" || a.slug === selected);
  const threadOpen = (t: AgentThread) => centre.kind === "thread" && (centre.id === t.sessionId || centre.id === t.shortId);
  const threadNeeds = (t: AgentThread) => needs.filter((n) => n.session === t.sessionId).length;
  /** A thread is in the tree while it runs, waits on him, or is open; done, it leaves. */
  const running = (t: AgentThread) => t.state === "busy" || t.state === "starting" || threadNeeds(t) > 0 || threadOpen(t);
  const byActivity = (x: AgentThread, y: AgentThread) => y.lastActivity - x.lastActivity;

  const threadRow = (t: AgentThread, depth: number, project = ""): TreeRow => ({
    id: `thread:${t.sessionId}`,
    label: t.title || t.shortId,
    depth,
    thread: true,
    working: t.state === "busy" || t.state === "starting",
    waiting: threadNeeds(t),
    on: threadOpen(t),
    icon: ORIGIN[originOf(t)]?.[1] ?? "message",
    title: `${t.title || t.shortId} · ${project || ORIGIN[originOf(t)]?.[0] || "agent"} · ${t.state}${t.cwd ? `\n${t.cwd}` : ""}`,
  });

  /** An agent's open tasks, as rows under it: decisions first, then what is worked on, then what waits. */
  const taskRows = (owner: string, depth: number): TreeRow[] =>
    tasks
      .filter((t) => t.owner === owner && t.status !== "done" && t.status !== "dropped")
      .sort((x, y) => TASK_ORDER.indexOf(x.status) - TASK_ORDER.indexOf(y.status) || y.id - x.id)
      .map((t) => ({
        id: `task:${t.id}`,
        label: t.title,
        depth,
        // A spinner means work happening now, never "a row exists".
        working: t.status === "active" && bySlug(owner)?.status === "working",
        waiting: t.status === "waiting_user" ? 1 : 0,
        on: centre.kind === "task" && centre.id === t.id,
        icon: TASK_ICON[t.status],
        title: `#${t.id} ${t.title} · ${t.status.replace("_", " ")}${t.due ? ` · due ${t.due}` : ""}`,
      }));

  const children = new Map<string | null, Agent[]>();
  for (const a of agents) if (shown(a)) children.set(a.parent, [...(children.get(a.parent) ?? []), a]);
  const dev = devAgent(agents);
  // Code threads come from every agent's list (a terminal's belong to pai) and gather under Dev by project.
  const code = agents.flatMap((a) => a.threads ?? []).filter((t) => isCode(t) && running(t));
  const projectRows = (depth: number) => {
    const byProject = new Map<string, AgentThread[]>(projects.map((p) => [p.slug, []]));
    for (const t of code) byProject.set(projectName(t), [...(byProject.get(projectName(t)) ?? []), t]);
    return [...byProject.entries()]
      .sort(([x], [y]) => x.localeCompare(y))
      .flatMap(([project, threads]): TreeRow[] => [
        { id: `project:${project}`, label: project, depth, working: false, waiting: 0, on: centre.kind === "project" && centre.slug === project, icon: "folder", title: `${project} · a repo: its threads, its tasks, its notes` },
        ...threads.sort(byActivity).map((t) => threadRow(t, depth + 1, project)),
      ]);
  };
  const out: TreeRow[] = [
    { id: PAI, label: "General", depth: 0, working: bySlug(PAI)?.status === "working", waiting: needs.filter((n) => (n.agent ?? PAI) === PAI && !(n.session && threadOf(agents, n.session))).length, on: centre.kind === "chat", icon: "home", title: "pai, the orchestrator" },
  ];
  const walk = (parent: string, depth: number) => {
    const list = (children.get(parent) ?? []).sort((x, y) => KIND_ORDER[x.kind] - KIND_ORDER[y.kind] || x.name.localeCompare(y.name));
    for (const a of list) {
      const open = tasks.filter((t) => t.owner === a.slug).length;
      out.push({
        id: a.slug,
        label: a.name,
        depth,
        thread: a.kind === "sub",
        working: a.status === "working",
        waiting: needs.filter((n) => n.agent === a.slug).length,
        on: a.slug === selected && centre.kind !== "board",
        icon: agentIcon(a),
        title: [`${a.name} · ${a.kind}`, STATUS[a.status] + (a.queued ? ` · ${a.queued} queued` : ""), open ? `${open} open task${open === 1 ? "" : "s"}` : "", a.model ? modelName(a.model) : ""].filter(Boolean).join("\n"),
      });
      out.push(...taskRows(a.slug, depth + 1));
      walk(a.slug, depth + 1);
      if (a.slug === dev?.slug) out.push(...projectRows(depth + 1));
      for (const t of (a.threads ?? []).filter((t) => !isCode(t) && running(t)).sort(byActivity)) out.push(threadRow(t, depth + 1));
    }
  };
  out.push(...taskRows(PAI, 1));
  walk(PAI, 1);
  if (!dev && (code.length || projects.length)) out.push({ id: "dev", label: DEV_LABEL, depth: 1, working: false, waiting: 0, on: false, icon: "code", inert: true }, ...projectRows(2));
  // What runs for General itself: a thread of no agent's, started from the box, the phone, the CLI or a routine.
  for (const t of (bySlug(PAI)?.threads ?? []).filter((t) => !isCode(t) && running(t)).sort(byActivity)) out.push(threadRow(t, 1));
  return out;
}
