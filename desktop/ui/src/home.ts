import { agentTasks } from "./agent-tasks.ts";
import { fillTaskPills, taskPills } from "./markdown.ts";
import { bodyPeek } from "./body-peek.ts";
import { projectThreads } from "./project-threads.ts";
import { agent as fetchAgent, agentInstructions, agents as listAgents, allTasks, configureAgent, file as readFile, follow, projects as listProjects, messageAgent, needs as listNeeds, pai as paiStatus, reconfigure, sendPai, sendThread, startThread, status, task as fetchTask, taskItems } from "./api.ts";
import { board, type Board } from "./board.ts";
import { chat, type Chat, type RevealTarget } from "./chat.ts";
import { crumbBar, type Crumb } from "./crumbs.ts";
import { basename, clear, el, modelName, skeleton, swap } from "./dom.ts";
import { icon, type IconName } from "./icons.ts";
import { markdown } from "./markdown.ts";
import { needsButton } from "./needs.ts";
import { projectPeek } from "./peek.ts";
import { sideTree, type TreeRow } from "./ptree.ts";
import { navigate } from "./router.ts";
import { save as saveState, state } from "./state.ts";
import { remember } from "./storage.ts";
import type { Agent, AgentStatus, AgentThread, Effort, LogMessage, Need, ProjectSummary, SessionSummary, TaskItem } from "./types.ts";

/**
 * The main view: on the left the tree — General, under it the agents as they report (each under the
 * one its reports go to), under each agent its sub-agents and the threads it is running; code threads
 * under Dev, a folder per project; and whatever runs for General itself. A thread that is not running
 * is not there: ⌘K finds it, and a message brings it back. The chat in the middle — pai's own, an
 * agent's, a thread's, a task's, or the board — with the hand above the box, and on the right who is
 * talking: the agent and what it is told. Usage sits in the box, the rest in settings.
 */

const PAI = "pai";
const STATUS: Record<AgentStatus, string> = { working: "working", waiting: "waiting on you", queued: "queued", idle: "idle", closed: "closed" };
const KIND_ORDER: Record<Agent["kind"], number> = { orchestrator: 0, standing: 1, service: 2, sub: 3 };
/** The tree's icon for an agent that none of the names below fit. */
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
const DEV_SLUGS = ["dev", "pai-dev"];
const DEV_LABEL = "Dev";
/** What a project's notes are: the files of its own that say what it is and how to work in it. */
const PROJECT_NOTES = ["CLAUDE.md", "README.md"];
/** The editor, on a project: its files and a terminal there. */
const openEditor = (project: string) => {
  state.project = project;
  saveState();
  navigate("editor");
};
/** What a session thinks at when nothing was asked for: Claude Code's own default. */
const DEFAULT_EFFORT: Effort = "high";
/** Where a thread was started, as a row says it and the icon it is drawn with; `agent` is the agent's own name. */
const ORIGIN: Record<string, readonly [string, IconName]> = {
  general: ["General", "message"],
  cli: ["CLI", "terminal"],
  terminal: ["Terminal", "terminal"],
  phone: ["Phone", "send"],
  builder: ["Builder", "code"],
  routine: ["Routine", "clock"],
  agent: ["", "bot"],
};

/** What a page shows: its conversations (a repo only), its tasks (the desk), its notes, or the chat. */
export type AgentView = "threads" | "tasks" | "notes" | "chat";
const AGENT_VIEWS: readonly { readonly view: AgentView; readonly icon: IconName; readonly title: string }[] = [
  { view: "tasks", icon: "list", title: "Tasks" },
  { view: "notes", icon: "book", title: "Notes: what it knows and runs with" },
  { view: "chat", icon: "message", title: "Chat with it" },
];
/** A repo also has its conversations, and leads with them: that is what he opens a project for. */
const PROJECT_VIEWS: readonly { readonly view: AgentView; readonly icon: IconName; readonly title: string }[] = [
  { view: "threads", icon: "message", title: "Conversations in this repo" },
  { view: "tasks", icon: "list", title: "Tasks of the agents working here" },
  { view: "notes", icon: "book", title: "Notes: its CLAUDE.md and README" },
  { view: "chat", icon: "plus", title: "Start a thread in it" },
];
const viewsFor = (slug: string) => (slug.startsWith("project:") ? PROJECT_VIEWS : AGENT_VIEWS);
const VIEW_KEY = "pai.agent.view";
/** The remembered views, by slug; a browser with none, or with an older shape under the key, starts with the defaults. */
function storedViews(): Record<string, AgentView> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(VIEW_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, AgentView>) : {};
  } catch {
    return {};
  }
}

export type Centre = { kind: "chat" } | { kind: "agent"; slug: string } | { kind: "project"; slug: string } | { kind: "task"; id: number } | { kind: "thread"; id: string } | { kind: "board"; slug?: string };

export function home(root: HTMLElement) {
  let agents: Agent[] = [];
  /** Every repo and context pai knows: each is a folder under Dev, threads or none. */
  let projects: ProjectSummary[] = [];
  let tasks: TaskItem[] = [];
  let needs: Need[] = [];
  /** pai's live session as last seen: its id, model and effort. */
  let paiSession: SessionSummary | undefined;
  /** The daemon's model for the main chat, for when the session has not answered yet. */
  let mainModel: string | undefined;
  void status()
    .then((h) => ((mainModel = h.settings.models.main), mainChat?.refreshPrefs()))
    .catch(() => undefined);
  let centre: Centre = { kind: "chat" };
  let mainChat: Chat | undefined;
  /** The chat in the centre other than pai's: an agent's (`agent:<slug>`) or a task's (`task:<id>`), with the agent it is with. */
  let agentChat: { key: string; slug: string; chat: Chat } | undefined;
  /** An agent's desk or notes in the centre, when its page is not on the chat. */
  let agentPage: { key: string; dispose?: () => void } | undefined;
  /** Which view each agent's page is on; General opens on its chat, an agent on its desk. */
  const views = new Map<string, AgentView>(Object.entries(storedViews()));
  const viewOf = (slug: string): AgentView => {
    const stored = views.get(slug);
    const allowed = viewsFor(slug).some((v) => v.view === stored);
    return allowed && stored ? stored : slug === PAI ? "chat" : slug.startsWith("project:") ? "threads" : "tasks";
  };
  const setView = (slug: string, view: AgentView) => {
    views.set(slug, view);
    remember(VIEW_KEY, JSON.stringify(Object.fromEntries(views)));
  };
  /** The task whose thread is open, closed ones included (the tree only holds open ones). */
  let openTask: TaskItem | undefined;
  let theBoard: Board | undefined;
  let loaded = false;
  /** A row to scroll to once the thread that holds it has loaded. */
  let pendingReveal: RevealTarget | undefined;
  /** The first message of a thread just started from pai's box, shown in it until its transcript has it. */
  let seed: { id: string; text: string } | undefined;

  const sidePane = el("aside.home-side");
  const treeList = el("div.ptree");
  clear(sidePane, treeList);
  const centrePane = el("section.home-centre");
  const crumbs = crumbBar();
  clear(root, sidePane, centrePane, crumbs.node);
  // The shape of the page before the daemon has answered: a tree, a chat.
  clear(treeList, skeleton("list", 9));

  const bySlug = (slug: string) => agents.find((a) => a.slug === slug);
  const nameOf = (slug: string) => (slug === "user" ? "you" : slug === PAI ? "General" : (bySlug(slug)?.name ?? slug));

  const ctx = {
    agents: () => agents,
    openAgent: (slug: string, at?: number) => {
      if (at !== undefined) pendingReveal = { messageId: at };
      if (slug === PAI) {
        navigate("home");
        if (pendingReveal && mainChat) {
          const target = pendingReveal;
          pendingReveal = undefined;
          void mainChat.reveal(target);
        }
        return;
      }
      navigate({ name: "chat", param: slug });
      if (pendingReveal && agentChat?.key === `agent:${slug}`) {
        const target = pendingReveal;
        pendingReveal = undefined;
        void agentChat.chat.reveal(target);
      }
    },
    openBoard: (slug: string) => navigate(slug === PAI ? "board" : { name: "board", param: slug }),
    openTask: (id: number) => navigate({ name: "task", param: String(id) }),
    openThread: (id: string) => navigate({ name: "thread", param: id }),
    openProject: (slug: string) => navigate({ name: "project", param: slug }),
  };

  // ---- the hand ------------------------------------------------------------------------------

  const hand = needsButton({ reveal });

  /** A need's row: in an agent's thread while that one is open, else in the main chat, where every ask to the user lands whoever asked. */
  async function reveal(n: Need) {
    const target: RevealTarget = n.kind === "ask" ? { askId: n.askId } : n.kind === "task" ? { taskId: n.taskId } : { question: true };
    if ((centre.kind === "agent" || centre.kind === "task") && agentChat?.slug === n.agent && (await agentChat.chat.reveal(target))) return;
    if (centre.kind !== "chat") navigate("home");
    if (viewOf(PAI) !== "chat") toChat(PAI);
    await mainChat?.reveal(target);
  }

  // ---- the tree ------------------------------------------------------------------------------

  const selectedSlug = () => (centre.kind === "agent" ? centre.slug : centre.kind === "project" ? (devAgent()?.slug ?? PAI) : centre.kind === "board" ? (centre.slug ?? PAI) : centre.kind === "task" ? (openTask?.owner ?? PAI) : centre.kind === "thread" ? (threadOf(centre.id)?.owner.slug ?? PAI) : PAI);
  /** An agent has a row while it is open; the one whose chat is open keeps its row whatever its state. */
  const shown = (a: Agent) => a.slug !== PAI && (a.status !== "closed" || a.slug === selectedSlug());
  const agentIcon = (a: Agent): IconName => AGENT_ICONS.find(([re]) => re.test(`${a.slug} ${a.name}`))?.[1] ?? KIND_ICON[a.kind];
  const devAgent = () => agents.find((a) => DEV_SLUGS.includes(a.slug) && a.status !== "closed");
  /** A thread of Claude Code in a repo: it is listed under Dev, in its project's folder. */
  const isCode = (t: AgentThread) => t.kind === "code" || Boolean(t.project);
  const projectName = (t: AgentThread) => t.project ?? (t.cwd ? basename(t.cwd) : "") ?? "";
  const threadOpen = (t: AgentThread) => centre.kind === "thread" && (centre.id === t.sessionId || centre.id === t.shortId);
  const threadNeeds = (t: AgentThread) => needs.filter((n) => n.session === t.sessionId).length;
  /** A thread is in the tree while it runs, waits on the user, or is open; done, it leaves. */
  const running = (t: AgentThread) => t.state === "busy" || t.state === "starting" || threadNeeds(t) > 0 || threadOpen(t);
  const waitingOn = (slug: string) => needs.filter((n) => n.agent === slug).length;

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
  const byActivity = (x: AgentThread, y: AgentThread) => y.lastActivity - x.lastActivity;

  function treeRows(): TreeRow[] {
    const children = new Map<string | null, Agent[]>();
    for (const a of agents) if (shown(a)) children.set(a.parent, [...(children.get(a.parent) ?? []), a]);
    const dev = devAgent();
    // Code threads come from every agent's list (a terminal's belong to pai) and gather under Dev by project.
    const code = agents.flatMap((a) => a.threads ?? []).filter((t) => isCode(t) && running(t));
    const projectRows = (depth: number) => {
      const byProject = new Map<string, AgentThread[]>(projects.map((p) => [p.slug, []]));
      for (const t of code) byProject.set(projectName(t), [...(byProject.get(projectName(t)) ?? []), t]);
      return [...byProject.entries()]
        .sort(([x], [y]) => x.localeCompare(y))
        .flatMap(([project, threads]): TreeRow[] => [{ id: `project:${project}`, label: project, depth, working: false, waiting: 0, on: centre.kind === "project" && centre.slug === project, icon: "folder", title: `${project} · a repo: its threads, its notes, its files` }, ...threads.sort(byActivity).map((t) => threadRow(t, depth + 1, project))]);
    };
    const out: TreeRow[] = [{ id: PAI, label: "General", depth: 0, working: bySlug(PAI)?.status === "working", waiting: needs.filter((n) => (n.agent ?? PAI) === PAI && !(n.session && threadOf(n.session))).length, on: centre.kind === "chat", icon: "home", title: "pai, the orchestrator" }];
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
          waiting: waitingOn(a.slug),
          on: a.slug === selectedSlug() && centre.kind !== "board",
          icon: agentIcon(a),
          title: [`${a.name} · ${a.kind}`, STATUS[a.status] + (a.queued ? ` · ${a.queued} queued` : ""), open ? `${open} open task${open === 1 ? "" : "s"}` : "", a.model ? modelName(a.model) : ""].filter(Boolean).join("\n"),
        });
        walk(a.slug, depth + 1);
        if (a.slug === dev?.slug) out.push(...projectRows(depth + 1));
        for (const t of (a.threads ?? []).filter((t) => !isCode(t) && running(t)).sort(byActivity)) out.push(threadRow(t, depth + 1));
      }
    };
    walk(PAI, 1);
    if (!dev && (code.length || projects.length)) out.push({ id: "dev", label: DEV_LABEL, depth: 1, working: false, waiting: 0, on: false, icon: "code", inert: true }, ...projectRows(2));
    // What runs for General itself: a thread of no agent's, started from the box, the phone, the CLI or a routine.
    for (const t of (bySlug(PAI)?.threads ?? []).filter((t) => !isCode(t) && running(t)).sort(byActivity)) out.push(threadRow(t, 1));
    return out;
  }

  /** The decisions an agent holds: its own and those of the sub-agents under it. */
  const needsOf = (slug: string) => {
    const known = new Map(agents.map((a) => [a.slug, a]));
    const under = (s: string): boolean => {
      for (let a = known.get(s); a; a = a.parent ? known.get(a.parent) : undefined) if (a.slug === slug) return true;
      return false;
    };
    return needs.filter((n) => n.agent && under(n.agent));
  };
  const peek = projectPeek({
    needsOf,
    working: (slug) => bySlug(slug)?.status === "working",
    openTask: (id) => ctx.openTask(id),
    reveal: (need) => void reveal(need),
    answered: () => void refreshNeeds(),
  });

  /** A thread by its session id, with the agent it is listed under. */
  function threadOf(id: string): { thread: AgentThread; owner: Agent } | undefined {
    for (const a of agents) {
      const thread = a.threads?.find((t) => t.sessionId === id || t.shortId === id);
      if (thread) return { thread, owner: a };
    }
    return undefined;
  }

  /** How a thread was started; a daemon that does not say: a project means Claude Code in its folder, else an agent. */
  const originOf = (thread: AgentThread) => thread.origin ?? (thread.project || thread.kind === "code" ? "terminal" : "agent");

  const openRow = (id: string) => {
    if (id.startsWith("thread:")) ctx.openThread(id.slice("thread:".length));
    else if (id.startsWith("project:")) ctx.openProject(id.slice("project:".length));
    else ctx.openAgent(id);
  };
  const tree = sideTree(treeList, openRow, (row, id) => !id.includes(":") && id !== PAI && bySlug(id) && peek.attach(row, id));
  const drawTree = () => {
    tree.draw(treeRows());
    peek.redraw();
  };

  // ---- the centre ----------------------------------------------------------------------------

  const liveSession = () =>
    paiStatus()
      .then((p) => ((paiSession = p.session), mainChat?.refreshPrefs(), p.session?.sessionId))
      .catch(() => undefined);
  const paiPrefs = () => (paiSession ? { model: paiSession.modelPref ?? paiSession.model ?? mainModel, effort: paiSession.effort ?? DEFAULT_EFFORT } : undefined);
  const setPaiPrefs = async (changes: { model?: string | null; effort?: Effort | null }) => {
    if (!paiSession) return { error: "no session yet" };
    const result = await reconfigure(paiSession.sessionId, changes);
    if (!result.error) paiSession = { ...paiSession, modelPref: changes.model === undefined ? paiSession.modelPref : changes.model, effort: changes.effort === undefined ? paiSession.effort : changes.effort };
    return { error: result.error };
  };

  function disposeCentre() {
    agentChat?.chat.dispose();
    agentChat = undefined;
    agentPage?.dispose?.();
    agentPage = undefined;
    theBoard?.dispose();
    theBoard = undefined;
  }

  // ---- a new thread from pai's box: on, the chat clears; the first message starts the thread and opens it ----

  let detached = false;
  const detachSwitch = el("button.compose-tool.detach", { title: "start a new thread on its own: not pai, no project", onclick: () => setDetached(!detached) }, icon("plus", 12), el("span", {}, "New thread"));
  function setDetached(on: boolean) {
    detached = on;
    detachSwitch.classList.toggle("on", on);
    centrePane.classList.toggle("detached", on);
    mainChat?.box.placeholder(on ? "Start a new thread…" : undefined);
    drawHead();
    drawViewSwitch();
    if (on) mainChat?.focus();
  }
  const startDetached = async (text: string, images: { media_type: string; data: string }[]) => {
    const result = await startThread(text, images);
    const started = result.data as SessionSummary | undefined;
    if (result.error || !started?.sessionId) {
      if (mainChat) mainChat.box.note.textContent = result.error ?? (result.queued ? "offline — start it again once the daemon answers" : "no thread came back");
      return;
    }
    seed = { id: started.sessionId, text: text || "(image)" };
    setDetached(false);
    ctx.openThread(started.sessionId);
  };

  function showMain() {
    const view = viewOf(PAI);
    if (view !== "chat") return void showPage(PAI, view);
    mainChat ??= chat(
      { agent: PAI, parent: "user", live: liveSession, prefs: paiPrefs, setPrefs: setPaiPrefs, send: (text, images) => sendPai(text, images), placeholder: "Message pai…", boxExtra: detachSwitch, divert: () => (detached ? startDetached : undefined) },
      ctx,
    );
    mainChat.slot.append(hand.node);
    swap(centrePane, mainChat.node);
    mainChat.focus();
    if (pendingReveal) {
      const target = pendingReveal;
      pendingReveal = undefined;
      const chat = mainChat;
      setTimeout(() => void chat.reveal(target), 400);
    }
  }

  const lineage = (slug: string) => {
    const chain: Agent[] = [];
    for (let a = bySlug(slug); a && a.slug !== PAI && !chain.includes(a); a = a.parent ? bySlug(a.parent) : undefined) chain.unshift(a);
    return chain;
  };

  /** General › parent › … › the agent (› the task | › the thread): the way here, each step before the last a way back. */
  function headCrumbs(): Crumb[] {
    if (centre.kind === "board") return [];
    if (centre.kind === "chat") return [detached ? { key: "new", label: "New thread" } : { key: PAI, label: "General" }];
    const general: Crumb = { key: PAI, label: "General", open: () => navigate("home") };
    const agentCrumb = (a: Agent): Crumb => ({ key: `agent:${a.slug}`, label: a.name, open: () => ctx.openAgent(a.slug) });
    const projectCrumb = (slug: string): Crumb => ({ key: `project:${slug}`, label: slug, open: () => ctx.openProject(slug) });
    if (centre.kind === "project") {
      const dev = devAgent();
      return [general, dev ? agentCrumb(dev) : { key: "dev", label: DEV_LABEL }, projectCrumb(centre.slug)];
    }
    if (centre.kind === "thread") {
      const id = centre.id;
      const found = threadOf(id);
      const owner = found?.owner;
      const title = found ? found.thread.title || found.thread.shortId : "New thread";
      const dev = devAgent();
      const way: Crumb[] = !found
        ? []
        : isCode(found.thread)
          ? [dev ? agentCrumb(dev) : { key: "dev", label: DEV_LABEL }, projectCrumb(projectName(found.thread))]
          : owner && owner.slug !== PAI && found.thread.origin === "agent"
            ? [agentCrumb(owner)]
            : [];
      return [general, ...way, { key: `thread:${id}`, label: title, title }];
    }
    const slug = centre.kind === "agent" ? centre.slug : (openTask?.owner ?? PAI);
    const chain = lineage(slug).map(agentCrumb);
    const known = bySlug(slug);
    if (!chain.length && slug !== PAI) chain.push({ key: `agent:${slug}`, label: known?.name ?? slug, open: () => ctx.openAgent(slug) });
    const task = centre.kind === "task" ? [{ key: `task:${centre.id}`, label: openTask ? `#${centre.id} ${openTask.title}` : `#${centre.id}`, title: openTask?.title }] : [];
    return [general, ...chain, ...task];
  }
  const drawHead = () => crumbs.set(headCrumbs());

  /** The slug whose page the centre is: General's or an agent's. */
  const pageSlug = () => (centre.kind === "chat" && !detached ? PAI : centre.kind === "agent" ? centre.slug : centre.kind === "project" ? `project:${centre.slug}` : undefined);
  /** Whose tasks are on a desk: the agent's own and those of the sub-agents working under it, not a standing agent's below. */
  const underDesk = (slug: string, owner: string) => {
    for (let a = bySlug(owner); a; a = a.parent ? bySlug(a.parent) : undefined) {
      if (a.slug === slug) return true;
      if (a.kind !== "sub") return false;
    }
    return false;
  };
  /** The chat with an agent (General's own for pai), with its box focused: where a task is asked for. */
  const toChat = (slug: string) => {
    setView(slug, "chat");
    disposeCentre();
    showSlug(slug);
    drawViewSwitch();
    setTimeout(() => (slug === PAI ? mainChat?.focus() : agentChat?.chat.focus()), 50);
  };
  /** The page of a slug: General's, a project's (`project:<slug>`) or an agent's. */
  const showSlug = (slug: string) => {
    if (slug === PAI) showMain();
    else if (slug.startsWith("project:")) void showProject(slug.slice("project:".length));
    else void showAgent(slug);
  };

  /** Whose tasks a project's desk holds: the agents that work in that repo, and their sub-agents. */
  const underProject = (project: string, owner: string) => {
    for (let a = bySlug(owner); a; a = a.parent ? bySlug(a.parent) : undefined) {
      if (a.project === project) return true;
      if (a.kind !== "sub") return false;
    }
    return false;
  };

  /** A page's desk — the tasks it holds, grouped by state — or its notes: an agent's or a project's. */
  async function showPage(slug: string, view: Exclude<AgentView, "chat">) {
    const key = `agent:${slug}:${view}`;
    const project = slug.startsWith("project:") ? slug.slice("project:".length) : undefined;
    if (view === "threads") {
      agentPage = { key };
      swap(centrePane, el("div.agent-view", {}, skeleton("lines", 5)));
      const path = projects.find((p) => p.slug === project)?.path ?? (await listProjects().catch(() => [] as ProjectSummary[])).find((p) => p.slug === project)?.path;
      if (agentPage?.key !== key) return;
      const list = path ? projectThreads(path, { openThread: ctx.openThread, newThread: () => toChat(slug) }) : undefined;
      agentPage = { key, dispose: list?.dispose };
      swap(centrePane, list?.node ?? el("div.agent-view", {}, el("p.info-dim", {}, "This project has no directory on the box.")));
      return;
    }
    if (view === "tasks") {
      const desk = agentTasks(slug, { under: (owner) => (project ? underProject(project, owner) : underDesk(slug, owner)), nameOf, working: (owner) => bySlug(owner)?.status === "working", openTask: ctx.openTask, selected: () => undefined, newTask: () => toChat(slug) });
      agentPage = { key, dispose: desk.dispose };
      swap(centrePane, el("div.agent-view", {}, desk.node));
      return;
    }
    const page = el("div.agent-view", {}, el("div.agent-notes", {}, skeleton("lines", 6)));
    agentPage = { key };
    swap(centrePane, page);
    const files = project ? await projectNotes(project) : await agentNotes(slug);
    if (agentPage?.key !== key) return;
    const a = project ? undefined : bySlug(slug);
    const head = a && slug !== PAI ? reportsLine(a) : undefined;
    clear(
      page,
      el("div.agent-notes", {}, head, ...(files.length ? files.map((f) => el("section.agent-note", {}, el("h3.agent-note-name", {}, f.name === "STATE.md" ? "Where things stand" : f.name), el("div.agent-note-body", {}, markdown(f.text)))) : [el("p.info-dim", {}, "Nothing written yet.")])),
    );
  }
  const agentNotes = async (slug: string) => {
    const notes = await agentInstructions(slug).catch(() => undefined);
    return notes ? [...notes.files].sort((x, y) => Number(y.name === "STATE.md") - Number(x.name === "STATE.md")) : [];
  };
  /** A repo's own notes: its CLAUDE.md and README, read from the box. */
  const projectNotes = async (slug: string) => {
    const project = projects.find((p) => p.slug === slug) ?? (await listProjects().catch(() => [] as ProjectSummary[])).find((p) => p.slug === slug);
    if (!project) return [];
    const reads = await Promise.all(PROJECT_NOTES.map((name) => readFile(`${project.path}/${name}`).then((f) => ({ name, text: f.text }), () => undefined)));
    return reads.filter((f): f is { name: string; text: string } => Boolean(f?.text.trim()));
  };
  /** Over an agent's notes: whom it reports to, and whether what it hears goes on up. */
  const reportsLine = (a: Agent) =>
    el(
      "p.agent-reports",
      {},
      `Reports to ${nameOf(a.parent ?? PAI)} · `,
      el("button.info-link", { title: "whether reports it receives from the agents under it go on up to its own parent", onclick: () => void configureAgent(a.slug, { bubble: a.bubble === false }).then(refreshAgents).then(() => (disposeCentre(), showSlug(a.slug))) }, a.bubble === false ? "keeps what it hears" : "passes reports up"),
    );

  /** A project's page: the desk of the agents working in it, its notes, or a box that starts a thread in it. The editor is one icon away. */
  async function showProject(slug: string) {
    const view = viewOf(`project:${slug}`);
    if (view !== "chat") {
      await showPage(`project:${slug}`, view);
      drawHead();
      return;
    }
    const key = `project:${slug}`;
    const thread = chat({ agent: "thread", parent: "user", send: async () => ({ error: "start the thread first" }), placeholder: `Start a thread in ${slug}…`, divert: () => startInProject(slug) }, ctx);
    agentChat = { key, slug: devAgent()?.slug ?? PAI, chat: thread };
    swap(centrePane, thread.node);
    drawHead();
  }
  const startInProject = (project: string) => async (text: string, images: { media_type: string; data: string }[]) => {
    const result = await startThread(text, images, project);
    const started = result.data as SessionSummary | undefined;
    if (result.error || !started?.sessionId) {
      if (agentChat) agentChat.chat.box.note.textContent = result.error ?? (result.queued ? "offline — start it again once the daemon answers" : "no thread came back");
      return;
    }
    seed = { id: started.sessionId, text: text || "(image)" };
    ctx.openThread(started.sessionId);
  };

  /** An agent's page: by default its desk, else its notes or the chat with it. */
  async function showAgent(slug: string) {
    const existing = bySlug(slug);
    const view = viewOf(slug);
    if (view !== "chat") {
      await showPage(slug, view);
      drawHead();
      return;
    }
    const key = `agent:${slug}`;
    const thread = chat({ agent: slug, parent: existing?.parent ?? PAI, prefs: () => (bySlug(slug)?.model ? { model: bySlug(slug)!.model, effort: DEFAULT_EFFORT } : undefined), send: (text, images) => messageAgent(slug, text, undefined, images), placeholder: `Tell ${existing?.name ?? slug}…` }, ctx);
    agentChat = { key, slug, chat: thread };
    thread.slot.append(hand.node);
    swap(centrePane, thread.node);
    if (existing?.status === "closed") thread.node.querySelector<HTMLElement>(".input")?.setAttribute("contenteditable", "false");
    drawHead();
    const full = await fetchAgent(slug).catch(() => undefined);
    if (full && agentChat?.key === key) drawHead();
    if (agentChat?.key !== key) return;
    if (pendingReveal) {
      const target = pendingReveal;
      pendingReveal = undefined;
      setTimeout(() => void thread.reveal(target), 400);
    }
  }

  /** The switch after the name in the crumbs: tasks, notes, chat — for General and for an agent. */
  const viewSwitch = el("span.view-switch");
  const drawViewSwitch = () => {
    const slug = pageSlug();
    viewSwitch.hidden = !slug;
    if (!slug) return;
    const view = viewOf(slug);
    const project = slug.startsWith("project:") ? slug.slice("project:".length) : undefined;
    clear(
      viewSwitch,
      ...(project ? [el("button.view-btn.files", { title: "its files and a terminal: the editor", onclick: () => openEditor(project) }, icon("terminal", 13))] : []),
      ...viewsFor(slug).map((v) =>
        el(
          "button.view-btn",
          {
            class: `view-btn${v.view === view ? " on" : ""}`,
            title: v.title,
            onclick: () => {
              if (v.view === view) return;
              setView(slug, v.view);
              disposeCentre();
              showSlug(slug);
              drawViewSwitch();
            },
          },
          icon(v.icon, 13),
        ),
      ),
    );
  };
  crumbs.tail.append(viewSwitch);

  /** A task's thread: what was said about it, to and by the agent that owns it; what is written here reaches that agent about this task. */
  async function showTask(id: number) {
    const key = `task:${id}`;
    openTask = tasks.find((t) => t.id === id) ?? (await fetchTask(id).catch(() => undefined));
    if (centre.kind !== "task" || centre.id !== id) return;
    const owner = openTask?.owner ?? PAI;
    const agent = bySlug(owner);
    const thread = chat(
      {
        agent: owner,
        task: id,
        parent: owner === PAI ? "user" : (agent?.parent ?? PAI),
        send: (text, images) => (owner === PAI ? sendPai(`${text}\n\n(task #${id})`, images) : messageAgent(owner, text, id, images)),
        placeholder: `Message ${owner === PAI ? "pai" : (agent?.name ?? owner)} about this task…`,
      },
      ctx,
    );
    agentChat = { key, slug: owner, chat: thread };
    thread.slot.append(hand.node);
    swap(centrePane, thread.node);
    drawHead();
    drawTree();
  }

  /** A plain thread: its own transcript, its own session; General › (the agent that started it ›) its title. */
  function showThread(id: string) {
    const key = `thread:${id}`;
    const found = threadOf(id);
    const first = seed?.id === id ? seed.text : undefined;
    seed = undefined;
    const thread = chat(
      {
        agent: "thread",
        parent: "user",
        session: id,
        seed: first,
        projectPath: () => threadOf(id)?.thread.cwd ?? undefined,
        prefs: () => {
          const t = threadOf(id)?.thread;
          return t ? { model: t.modelPref ?? t.model ?? undefined, effort: t.effort ?? DEFAULT_EFFORT } : undefined;
        },
        setPrefs: async (changes) => ({ error: (await reconfigure(id, changes)).error }),
        send: (text, images) => sendThread(id, text, images),
        placeholder: "Message this thread…",
      },
      ctx,
    );
    agentChat = { key, slug: found?.owner.slug ?? PAI, chat: thread };
    thread.slot.append(hand.node);
    swap(centrePane, thread.node);
    drawHead();
  }

  function showBoard(slug?: string) {
    theBoard = board(slug, { agents: () => agents, openAgent: ctx.openAgent, onSelect: (s) => navigate(s === PAI ? "board" : { name: "board", param: s }, true) });
    swap(centrePane, theBoard.node);
  }

  function show(next: Centre) {
    const sameChat = (next.kind === "agent" && (agentChat?.key === `agent:${next.slug}` || agentPage?.key === `agent:${next.slug}:${viewOf(next.slug)}`)) || (next.kind === "project" && (agentChat?.key === `project:${next.slug}` || agentPage?.key === `agent:project:${next.slug}:${viewOf(`project:${next.slug}`)}`)) || (next.kind === "task" && agentChat?.key === `task:${next.id}`) || (next.kind === "thread" && agentChat?.key === `thread:${next.id}`);
    if (next.kind !== "chat" && detached) setDetached(false);
    const sameBoard = next.kind === "board" && theBoard;
    centre = next;
    if (!(next.kind === "task" && sameChat)) openTask = undefined;
    if (sameBoard) theBoard!.select(next.slug ?? PAI);
    else if (!sameChat) {
      disposeCentre();
      if (next.kind === "chat") showMain();
      else if (next.kind === "agent") void showAgent(next.slug);
      else if (next.kind === "project") void showProject(next.slug);
      else if (next.kind === "task") void showTask(next.id);
      else if (next.kind === "thread") showThread(next.id);
      else showBoard(next.slug);
    }
    root.classList.toggle("board-mode", next.kind === "board");
    drawHead();
    drawViewSwitch();
    drawTree();
  }

  // ---- loading and following -----------------------------------------------------------------

  async function refreshNeeds() {
    needs = await listNeeds().catch(() => needs);
    hand.draw(needs);
    drawTree();
  }

  async function load() {
    [agents, tasks, needs, projects] = await Promise.all([listAgents().catch(() => [] as Agent[]), taskItems().catch(() => [] as TaskItem[]), listNeeds().catch(() => [] as Need[]), listProjects().catch(() => [] as ProjectSummary[])]);
    drawTree();
    hand.draw(needs);
    void indexTasks();
  }

  /**
   * Every task by id, closed ones included, so `#20` in a message can say what it was and read as
   * closed. Open tasks are already here; the rest are fetched once and refreshed when one changes.
   */
  const taskIndex = new Map<number, TaskItem>();
  let indexing: Promise<void> | undefined;
  async function indexTasks() {
    indexing ??= allTasks()
      .then((all) => {
        for (const t of all) taskIndex.set(t.id, t);
        // Rows drawn before the index arrived kept their `#id` as text; now it can be a pill.
        fillTaskPills();
      })
      .catch(() => undefined)
      .finally(() => (indexing = undefined));
    await indexing;
  }
  taskPills(
    (id) => {
      const t = taskIndex.get(id) ?? tasks.find((x) => x.id === id);
      return t ? { id: t.id, title: t.title, status: t.status, owner: nameOf(t.owner), due: t.due, nextAction: t.nextAction } : undefined;
    },
    (id) => ctx.openTask(id),
    (pill, task) =>
      bodyPeek().arm(pill, `task${task.id}`, () => {
        const live = taskIndex.get(task.id) ?? task;
        return {
          body: `**#${live.id} ${live.title}**\n\n${live.nextAction?.trim() || "_no next action_"}`,
          foot: [live.status.replace("_", " "), live.owner, live.due ? `due ${live.due}` : "", "click opens it"].filter(Boolean).join(" · "),
        };
      }),
  );

  let threadsTimer: ReturnType<typeof setTimeout> | undefined;
  const refreshAgents = () => listAgents().then((all) => ((agents = all), drawTree(), drawHead()));
  /** The bell's press: a task, or a chat (at a row of it). */
  const openNotice = (event: Event) => {
    const { agent, id, task } = (event as CustomEvent<{ agent?: string; id?: number; task?: number }>).detail;
    if (task) return ctx.openTask(task);
    const slug = agent && bySlug(agent) ? agent : PAI;
    if (viewOf(slug) !== "chat") {
      setView(slug, "chat");
      if (pageSlug() === slug) disposeCentre();
    }
    ctx.openAgent(slug, id);
  };
  window.addEventListener("pai:open", openNotice);
  const stop = follow(
    undefined,
    (event) => {
      const payload = event.payload;
      switch (event.kind) {
        case "message.new": {
          const m = payload as unknown as LogMessage;
          if (m.kind === "ask" || m.kind === "answer") void refreshNeeds();
          break;
        }
        case "task.added":
        case "task.updated": {
          const t = payload as unknown as TaskItem;
          if (typeof t?.id === "number") taskIndex.set(t.id, t);
          fillTaskPills();
          break;
        }
        case "agent.changed":
        case "agent.created": {
          const changed = payload as unknown as Agent;
          const index = agents.findIndex((a) => a.slug === changed.slug);
          if (index < 0) void listAgents().then((all) => ((agents = all), drawTree(), drawHead(), mainChat?.refreshAgents(), theBoard?.refreshAgents()));
          else {
            agents[index] = { ...agents[index]!, ...changed };
            drawTree();
            drawHead();
            mainChat?.refreshAgents();
            agentChat?.chat.refreshAgents();
            theBoard?.refreshAgents();
          }
          break;
        }
        case "task.added":
        case "task.updated": {
          const t = payload as unknown as TaskItem;
          const open = t.status !== "done" && t.status !== "dropped";
          const index = tasks.findIndex((x) => x.id === t.id);
          if (index >= 0) {
            if (open) tasks[index] = { ...tasks[index]!, ...t };
            else tasks.splice(index, 1);
          } else if (open) tasks.push(t);
          if (openTask?.id === t.id) {
            openTask = { ...openTask, ...t };
            drawHead();
          }
          drawTree();
          if (t.status === "waiting_user" || (payload as { previous?: string }).previous === "waiting_user") void refreshNeeds();
          break;
        }
        // A thread started, answered or ended: the threads under each agent follow.
        case "session.started":
        case "session.exit":
        case "session.titled":
        case "session.turn_end":
        case "task.created":
          clearTimeout(threadsTimer);
          threadsTimer = setTimeout(() => void refreshAgents(), event.kind === "session.started" || event.kind === "task.created" ? 1500 : 200);
          break;
        case "session.question":
        case "session.answer":
        case "ask.created":
        case "ask.answered":
          void refreshNeeds();
          break;
      }
    },
    { replay: false },
  );

  void load().then(() => {
    loaded = true;
    show(centre);
  });

  return {
    show(next: Centre) {
      if (!loaded) {
        centre = next;
        return;
      }
      show(next);
    },
    /** The open chat's box, for keyboard focus. */
    focus: () => (centre.kind === "chat" ? mainChat?.focus() : agentChat?.chat.focus()),
    dispose() {
      stop();
      window.removeEventListener("pai:open", openNotice);
      disposeCentre();
      mainChat?.dispose();
    },
    refresh: () => void load().then(() => show(centre)),
  };
}
