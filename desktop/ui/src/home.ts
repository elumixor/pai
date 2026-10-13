import { agent as fetchAgent, agentInstructions, agents as listAgents, follow, messageAgent, needs as listNeeds, pai as paiStatus, reconfigure, sendPai, sendThread, startThread, status, task as fetchTask, taskItems } from "./api.ts";
import { board, type Board } from "./board.ts";
import { chat, type Chat, type RevealTarget } from "./chat.ts";
import { basename, clear, el, modelName, stamp } from "./dom.ts";
import { icon, type IconName } from "./icons.ts";
import { markdown } from "./markdown.ts";
import { needsButton } from "./needs.ts";
import { projectPeek } from "./peek.ts";
import { projectTree, threadList, type ThreadRow, type TreeRow } from "./ptree.ts";
import { navigate } from "./router.ts";
import type { Agent, AgentStatus, AgentThread, Effort, LogMessage, Need, SessionSummary, TaskItem, TaskStatus } from "./types.ts";

/**
 * The main view: General and the projects on the left (each one an agent, nested as the agents are)
 * and under them the threads, newest first — an agent's job on one task (a sub-agent), a thread an
 * agent started, a builder thread, a terminal's `claude`, one from the phone, one started on its own
 * from pai's box. The chat in the middle — pai's own, an agent's, a thread's, a task's, or the board —
 * with the hand above the box, and on the right who is talking: the agent and what it is told.
 * Usage sits in the box, the rest in settings.
 */

const PAI = "pai";
const STATUS: Record<AgentStatus, string> = { working: "working", waiting: "waiting on you", queued: "queued", idle: "idle", closed: "closed" };
const KIND_ORDER: Record<Agent["kind"], number> = { orchestrator: 0, standing: 1, service: 2, sub: 3 };
/** What a session thinks at when nothing was asked for: Claude Code's own default. */
const DEFAULT_EFFORT: Effort = "high";
/** A closed sub-agent stays in the threads this long: a finished job is still worth a look. */
const CLOSED_SHOWN_MS = 3 * 86_400_000;
const TASK_STATUS: Record<TaskStatus, string> = { inbox: "inbox", active: "active", waiting_user: "waiting on you", waiting_other: "waiting on someone", scheduled: "scheduled", done: "done", dropped: "dropped" };
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

export type Centre = { kind: "chat" } | { kind: "agent"; slug: string } | { kind: "task"; id: number } | { kind: "thread"; id: string } | { kind: "board"; slug?: string };

export function home(root: HTMLElement) {
  let agents: Agent[] = [];
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
  /** The task whose thread is open, closed ones included (the tree only holds open ones). */
  let openTask: TaskItem | undefined;
  let theBoard: Board | undefined;
  let loaded = false;
  /** A row to scroll to once the thread that holds it has loaded. */
  let pendingReveal: RevealTarget | undefined;
  /** The first message of a thread just started from pai's box, shown in it until its transcript has it. */
  let seed: { id: string; text: string } | undefined;

  const sidePane = el("aside.home-side");
  const projectsList = el("div.side-list");
  const threadsList = el("div.side-list.threads");
  clear(sidePane, projectsList, threadsList);
  const centrePane = el("section.home-centre");
  const infoPane = el("aside.home-info");
  clear(root, sidePane, centrePane, infoPane);

  const bySlug = (slug: string) => agents.find((a) => a.slug === slug);
  const nameOf = (slug: string) => (slug === "user" ? "you" : slug === PAI ? "General" : (bySlug(slug)?.name ?? slug));

  const ctx = {
    agents: () => agents,
    openAgent: (slug: string, at?: number) => {
      if (slug === PAI) return void navigate("home");
      if (at !== undefined) pendingReveal = { messageId: at };
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
  };

  // ---- the hand ------------------------------------------------------------------------------

  const hand = needsButton({ reveal });

  /** A need's row: in an agent's thread while that one is open, else in the main chat, where every ask to the user lands whoever asked. */
  async function reveal(n: Need) {
    const target: RevealTarget = n.kind === "ask" ? { askId: n.askId } : n.kind === "task" ? { taskId: n.taskId } : { question: true };
    if ((centre.kind === "agent" || centre.kind === "task") && agentChat?.slug === n.agent && (await agentChat.chat.reveal(target))) return;
    if (centre.kind !== "chat") navigate("home");
    await mainChat?.reveal(target);
  }

  // ---- the tree ------------------------------------------------------------------------------

  const selectedSlug = () => (centre.kind === "agent" ? centre.slug : centre.kind === "board" ? (centre.slug ?? PAI) : centre.kind === "task" ? (openTask?.owner ?? PAI) : centre.kind === "thread" ? (threadOf(centre.id)?.owner.slug ?? PAI) : PAI);
  /** Standing and service agents are projects; a sub-agent is a job inside one and folds into its nearest shown ancestor. */
  const shown = (a: Agent) => a.slug !== PAI && a.kind !== "sub" && (a.status !== "closed" || a.slug === selectedSlug());

  function treeRows(): TreeRow[] {
    const known = new Map(agents.map((a) => [a.slug, a]));
    const anchor = (a: Agent): string | null => {
      for (let p = a.parent ? known.get(a.parent) : undefined; p; p = p.parent ? known.get(p.parent) : undefined) if (shown(p)) return p.slug;
      return null;
    };
    const children = new Map<string | null, Agent[]>();
    const folded = new Map<string, Agent[]>();
    for (const a of agents) {
      if (shown(a)) children.set(anchor(a), [...(children.get(anchor(a)) ?? []), a]);
      else if (a.kind === "sub" && a.status !== "closed") {
        const into = anchor(a);
        if (into) folded.set(into, [...(folded.get(into) ?? []), a]);
      }
    }
    const waitingOn = (slug: string) => needs.filter((n) => n.agent === slug).length;
    const out: TreeRow[] = [{ id: PAI, label: "General", depth: 0, working: bySlug(PAI)?.status === "working", waiting: needs.filter((n) => (n.agent ?? PAI) === PAI && !(n.session && threadOf(n.session))).length, on: centre.kind === "chat", group: true, title: "pai, the orchestrator" }];
    const walk = (parent: string | null, depth: number) => {
      const list = (children.get(parent) ?? []).sort((x, y) => KIND_ORDER[x.kind] - KIND_ORDER[y.kind] || x.name.localeCompare(y.name));
      for (const a of list) {
        const subs = folded.get(a.slug) ?? [];
        const working = a.status === "working" || subs.some((s) => s.status === "working");
        const waiting = waitingOn(a.slug) + subs.reduce((n, s) => n + waitingOn(s.slug), 0);
        const open = tasks.filter((t) => t.owner === a.slug).length;
        out.push({
          id: a.slug,
          label: a.name,
          depth,
          working,
          waiting,
          on: a.slug === selectedSlug() && centre.kind !== "board",
          group: depth === 0,
          title: [`${a.name} · ${a.kind}`, STATUS[a.status] + (a.queued ? ` · ${a.queued} queued` : ""), open ? `${open} open task${open === 1 ? "" : "s"}` : "", a.model ? modelName(a.model) : ""].filter(Boolean).join("\n"),
        });
        walk(a.slug, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }

  /** The decisions a project holds: its own and those of the sub-agents folded into it. */
  const needsOf = (slug: string) => {
    const known = new Map(agents.map((a) => [a.slug, a]));
    const under = (s: string): boolean => {
      for (let a = known.get(s); a; a = a.parent ? known.get(a.parent) : undefined) {
        if (a.slug === slug) return true;
        if (a.slug !== s && shown(a)) return false;
      }
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

  // ---- the threads: every conversation that is not a project's own chat, newest first ----------

  /** A thread by its session id, with the agent it is listed under. */
  function threadOf(id: string): { thread: AgentThread; owner: Agent } | undefined {
    for (const a of agents) {
      const thread = a.threads?.find((t) => t.sessionId === id || t.shortId === id);
      if (thread) return { thread, owner: a };
    }
    return undefined;
  }

  /** Where a thread belongs, in a word or two: the agent that started it, else how it was started (and the project it is in). */
  function contextOf(thread: AgentThread, owner: { slug: string; name: string }) {
    const origin = thread.origin ?? "agent";
    if (origin === "agent") return owner.slug === PAI ? "General" : owner.name;
    const label = ORIGIN[origin]?.[0] ?? origin;
    const where = thread.project ?? (origin === "terminal" && thread.cwd ? basename(thread.cwd) : "");
    return where ? `${label} · ${where}` : label;
  }

  /** The project a sub-agent's job is in: its nearest ancestor that is one, else General. */
  const projectOf = (a: Agent) => {
    for (let p = a.parent ? bySlug(a.parent) : undefined; p; p = p.parent ? bySlug(p.parent) : undefined) if (p.slug !== PAI && p.kind !== "sub") return p.name;
    return "General";
  };

  function threadRows(): ThreadRow[] {
    const rows: ThreadRow[] = [];
    for (const a of agents) {
      if (a.kind !== "sub" || (a.status === "closed" && a.slug !== selectedSlug() && Date.now() - (a.closedAt ?? a.lastActive ?? 0) > CLOSED_SHOWN_MS)) continue;
      rows.push({
        id: `agent:${a.slug}`,
        title: a.name,
        context: projectOf(a),
        at: a.lastActive ?? a.createdAt ?? 0,
        working: a.status === "working",
        waiting: needs.filter((n) => n.agent === a.slug).length,
        on: centre.kind === "agent" && centre.slug === a.slug,
        icon: "bot",
        faint: a.status === "closed",
        tip: [`${a.name} · ${STATUS[a.status]}`, a.brief.split("\n")[0]].filter(Boolean).join("\n"),
      });
    }
    for (const a of agents)
      for (const t of a.threads ?? [])
        rows.push({
          id: `thread:${t.sessionId}`,
          title: t.title || t.shortId,
          context: contextOf(t, a),
          at: t.lastActivity,
          working: t.state === "busy" || t.state === "starting",
          waiting: needs.filter((n) => n.session === t.sessionId).length,
          on: centre.kind === "thread" && (centre.id === t.sessionId || centre.id === t.shortId),
          icon: ORIGIN[t.origin ?? "agent"]?.[1] ?? "message",
          faint: t.state === "dead",
          tip: `${t.title || t.shortId} · ${t.state}${t.cwd ? `\n${t.cwd}` : ""}`,
        });
    return rows.sort((x, y) => y.at - x.at);
  }

  const openThreadRow = (id: string) => {
    const [kind, rest = ""] = id.split(/:(.*)/s);
    if (kind === "agent") ctx.openAgent(rest);
    else ctx.openThread(rest);
  };

  const drawTree = () => {
    projectTree(projectsList, treeRows(), (slug) => ctx.openAgent(slug), (row, id) => id !== PAI && peek.attach(row, id));
    peek.redraw();
    threadList(threadsList, threadRows(), openThreadRow);
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
    theBoard?.dispose();
    theBoard = undefined;
  }

  // ---- a new thread from pai's box: on, the chat clears; the first message starts the thread and opens it ----

  let detached = false;
  const detachSwitch = el("button.compose-tool.detach", { title: "start a new thread on its own: not pai, no project", onclick: () => setDetached(!detached) }, el("span.switch"), el("span", {}, "New thread"));
  function setDetached(on: boolean) {
    detached = on;
    detachSwitch.classList.toggle("on", on);
    centrePane.classList.toggle("detached", on);
    mainChat?.box.placeholder(on ? "Start a new thread…" : undefined);
    mainChat?.setHead(on ? "New thread" : "General");
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
    mainChat ??= chat(
      { agent: PAI, parent: "user", title: "General", live: liveSession, prefs: paiPrefs, setPrefs: setPaiPrefs, send: (text) => sendPai(text), placeholder: "Message pai…", boxExtra: detachSwitch, divert: () => (detached ? startDetached : undefined) },
      ctx,
    );
    mainChat.slot.append(hand.node);
    clear(centrePane, mainChat.node);
    mainChat.focus();
  }

  const lineage = (slug: string) => {
    const chain: Agent[] = [];
    for (let a = bySlug(slug); a && a.slug !== PAI && !chain.includes(a); a = a.parent ? bySlug(a.parent) : undefined) chain.unshift(a);
    return chain;
  };

  /** General › parent › … › this agent (› the task): every step before the last takes you back there. */
  function crumbsOf(agent: Agent, task?: TaskItem) {
    const chain = lineage(agent.slug);
    const crumbs = el("span.crumbs", {}, el("button.crumb", { onclick: () => navigate("home") }, "General"));
    for (const a of chain) {
      crumbs.append(el("span.crumb-sep", {}, "›"));
      crumbs.append(a.slug === agent.slug && !task ? el("span.crumb.here", {}, a.name) : el("button.crumb", { onclick: () => ctx.openAgent(a.slug) }, a.name));
    }
    if (!chain.length && agent.slug !== PAI) crumbs.append(el("span.crumb-sep", {}, "›"), el("span.crumb.here", {}, agent.name));
    if (task) crumbs.append(el("span.crumb-sep", {}, "›"), el("span.crumb.here", { title: task.title }, `#${task.id} ${task.title}`));
    return crumbs;
  }

  async function showAgent(slug: string) {
    const existing = bySlug(slug);
    const key = `agent:${slug}`;
    const thread = chat({ agent: slug, parent: existing?.parent ?? PAI, title: existing?.name ?? slug, prefs: () => (bySlug(slug)?.model ? { model: bySlug(slug)!.model, effort: DEFAULT_EFFORT } : undefined), send: (text) => messageAgent(slug, text), placeholder: `Message ${existing?.name ?? slug}…` }, ctx);
    agentChat = { key, slug, chat: thread };
    thread.slot.append(hand.node);
    clear(centrePane, thread.node);
    const draw = (agent: Agent) => {
      thread.setHead(crumbsOf(agent));
      if (agent.status === "closed") thread.node.querySelector<HTMLTextAreaElement>("textarea")?.setAttribute("disabled", "");
    };
    if (existing) draw(existing);
    const full = await fetchAgent(slug).catch(() => undefined);
    if (full && agentChat?.key === key) draw(full);
    if (agentChat?.key !== key) return;
    if (pendingReveal) {
      const target = pendingReveal;
      pendingReveal = undefined;
      setTimeout(() => void thread.reveal(target), 400);
    }
  }

  /** A task's thread: what was said about it, to and by the agent that owns it; what is written here reaches that agent about this task. */
  async function showTask(id: number) {
    const key = `task:${id}`;
    openTask = tasks.find((t) => t.id === id) ?? (await fetchTask(id).catch(() => undefined));
    if (centre.kind !== "task" || centre.id !== id) return;
    const owner = openTask?.owner ?? PAI;
    const agent = bySlug(owner);
    const title = openTask ? `#${id} ${openTask.title}` : `#${id}`;
    const thread = chat(
      {
        agent: owner,
        task: id,
        parent: owner === PAI ? "user" : (agent?.parent ?? PAI),
        title,
        send: (text) => (owner === PAI ? sendPai(`${text}\n\n(task #${id})`) : messageAgent(owner, text, id)),
        placeholder: `Message ${owner === PAI ? "pai" : (agent?.name ?? owner)} about this task…`,
      },
      ctx,
    );
    agentChat = { key, slug: owner, chat: thread };
    thread.slot.append(hand.node);
    clear(centrePane, thread.node);
    if (agent && openTask) thread.setHead(crumbsOf(agent, openTask));
    drawTree();
    drawInfo();
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
        title: found?.thread.title ?? "New thread",
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
    clear(centrePane, thread.node);
    drawThreadHead();
  }

  function drawThreadHead() {
    if (centre.kind !== "thread" || !agentChat?.key.startsWith("thread:")) return;
    const found = threadOf(centre.id);
    const crumbs = el("span.crumbs", {}, el("button.crumb", { onclick: () => navigate("home") }, "General"));
    const owner = found?.owner;
    if (owner && owner.slug !== PAI && found?.thread.origin === "agent") crumbs.append(el("span.crumb-sep", {}, "›"), el("button.crumb", { onclick: () => ctx.openAgent(owner.slug) }, owner.name));
    const title = found ? found.thread.title || found.thread.shortId : "New thread";
    crumbs.append(el("span.crumb-sep", {}, "›"), el("span.crumb.here", { title }, title));
    agentChat.chat.setHead(crumbs);
  }

  function showBoard(slug?: string) {
    theBoard = board(slug, { agents: () => agents, openAgent: ctx.openAgent, onSelect: (s) => navigate(s === PAI ? "board" : { name: "board", param: s }, true) });
    clear(centrePane, theBoard.node);
  }

  function show(next: Centre) {
    const sameChat = (next.kind === "agent" && agentChat?.key === `agent:${next.slug}`) || (next.kind === "task" && agentChat?.key === `task:${next.id}`) || (next.kind === "thread" && agentChat?.key === `thread:${next.id}`);
    if (next.kind !== "chat" && detached) setDetached(false);
    const sameBoard = next.kind === "board" && theBoard;
    centre = next;
    if (!(next.kind === "task" && sameChat)) openTask = undefined;
    if (sameBoard) theBoard!.select(next.slug ?? PAI);
    else if (!sameChat) {
      disposeCentre();
      if (next.kind === "chat") showMain();
      else if (next.kind === "agent") void showAgent(next.slug);
      else if (next.kind === "task") void showTask(next.id);
      else if (next.kind === "thread") showThread(next.id);
      else showBoard(next.slug);
    }
    if (next.kind !== "chat" && mainChat) mainChat.node.remove();
    root.classList.toggle("board-mode", next.kind === "board");
    drawTree();
    if (!sameChat) drawInfo();
  }

  // ---- the right: who this chat is with, and what it is told -----------------------------------

  let infoFor = "";
  /** The agent behind the open chat (and the task, in a task's thread): its setup, its brief, its files, the instructions it runs with. */
  function drawInfo() {
    if (centre.kind === "board") return void clear(infoPane);
    if (centre.kind === "thread") return drawThreadInfo(centre.id);
    const slug = centre.kind === "agent" ? centre.slug : centre.kind === "task" ? (openTask?.owner ?? "") : PAI;
    const key = `${centre.kind}:${slug}:${openTask?.id ?? ""}`;
    if (!slug || key === infoFor) return;
    infoFor = key;
    const a = bySlug(slug);
    const fact = (label: string, value: string | Node | undefined | null | false) => (value ? el("div.info-fact", {}, el("span.info-key", {}, label), el("span.info-val", {}, value)) : undefined);
    const head: (Node | undefined)[] = [];
    if (openTask) {
      const t = openTask;
      head.push(
        el("div.info-title", {}, icon("list", 11), el("span", {}, `#${t.id} ${t.title}`)),
        fact("Status", TASK_STATUS[t.status]),
        fact("Next", t.nextAction),
        fact("Due", t.due),
        fact("Source", t.source ? el("a", { href: t.source, target: "_blank", rel: "noreferrer" }, t.source.replace(/^https?:\/\//, "").slice(0, 40)) : undefined),
        t.notes ? el("div.info-text", {}, markdown(t.notes)) : undefined,
        el("div.info-sep"),
      );
    }
    const name = slug === PAI ? "General" : (a?.name ?? slug);
    head.push(
      el("div.info-title", {}, icon(slug === PAI ? "home" : "bot", 11), slug === PAI || !openTask ? el("span", {}, name) : el("button.info-link", { onclick: () => ctx.openAgent(slug) }, name)),
      fact("Kind", a ? `${a.kind}${a.status ? ` · ${STATUS[a.status]}` : ""}` : "orchestrator"),
      fact("Model", slug === PAI ? modelName(paiSession?.modelPref ?? paiSession?.model ?? mainModel ?? "") : a?.model ? modelName(a.model) : "default"),
      fact("Effort", slug === PAI ? (paiSession?.effort ?? undefined) : (a?.effort ?? undefined)),
      fact("Project", a?.project),
      fact("Tools", a?.tools?.length ? a.tools.join(", ") : slug === PAI ? undefined : "all"),
      fact("Today", a && slug !== PAI ? `${a.turnsToday}${a.budget ? ` / ${a.budget.turnsPerDay}` : ""} turns · $${a.costUsd.toFixed(2)}` : undefined),
      a?.unresolvedTools?.length ? fact("Missing", a.unresolvedTools.join(", ")) : undefined,
      a?.brief && slug !== PAI ? el("div.info-text", {}, markdown(a.brief)) : undefined,
    );
    const files = el("div.info-files", {}, el("p.info-dim", {}, "…"));
    clear(infoPane, el("div.info", {}, ...head, el("div.info-sep"), el("div.info-head", {}, "Instructions"), files));
    void agentInstructions(slug)
      .then((ins) => {
        if (infoFor !== key) return;
        const section = (title: string, body: Node, open = false) => el("details.info-doc", { open }, el("summary", {}, title), el("div.info-doc-body", {}, body));
        clear(
          files,
          ...ins.files.map((f, i) => section(f.name, markdown(f.text), i === 0)),
          section("Appended to Claude Code's prompt", el("pre.info-pre", {}, ins.system)),
          el("p.info-dim", { title: ins.folder }, ins.folder.replace(/^.*\/workspace/, "workspace")),
        );
      })
      .catch(() => infoFor === key && clear(files, el("p.info-dim", {}, "Instructions unavailable.")));
  }

  /** A plain thread's facts: where it came from, where it runs, what it runs with, what it cost. */
  function drawThreadInfo(id: string) {
    const found = threadOf(id);
    const t = found?.thread;
    const key = `thread:${id}:${t?.title ?? ""}:${t?.state ?? ""}:${t?.turns ?? ""}`;
    if (key === infoFor) return;
    infoFor = key;
    const fact = (label: string, value: string | undefined | null | false) => (value ? el("div.info-fact", {}, el("span.info-key", {}, label), el("span.info-val", {}, value)) : undefined);
    if (!t || !found) return void clear(infoPane, el("div.info", {}, el("div.info-title", {}, icon("message", 11), el("span", {}, "New thread")), el("p.info-dim", {}, "Starting…")));
    clear(
      infoPane,
      el(
        "div.info",
        {},
        el("div.info-title", {}, icon(ORIGIN[t.origin ?? "agent"]?.[1] ?? "message", 11), el("span", {}, t.title || t.shortId)),
        fact("From", contextOf(t, found.owner)),
        fact("State", t.state),
        fact("Project", t.project),
        fact("Folder", t.cwd?.replace(/^\/(Users|home)\/[^/]+/, "~")),
        fact("Model", modelName(t.modelPref ?? t.model ?? "") || undefined),
        fact("Effort", t.effort),
        fact("Turns", t.turns ? `${t.turns}${t.costUsd ? ` · $${t.costUsd.toFixed(2)}` : ""}` : undefined),
        fact("Started", t.startedAt ? stamp(t.startedAt) : undefined),
        fact("Active", stamp(t.lastActivity)),
        fact("Session", t.shortId),
      ),
    );
  }

  // ---- loading and following -----------------------------------------------------------------

  async function refreshNeeds() {
    needs = await listNeeds().catch(() => needs);
    hand.draw(needs);
    drawTree();
  }

  async function load() {
    [agents, tasks, needs] = await Promise.all([listAgents().catch(() => [] as Agent[]), taskItems().catch(() => [] as TaskItem[]), listNeeds().catch(() => [] as Need[])]);
    drawTree();
    hand.draw(needs);
  }

  let threadsTimer: ReturnType<typeof setTimeout> | undefined;
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
        case "agent.changed":
        case "agent.created": {
          const changed = payload as unknown as Agent;
          const index = agents.findIndex((a) => a.slug === changed.slug);
          if (index < 0) void listAgents().then((all) => ((agents = all), drawTree(), mainChat?.refreshAgents(), theBoard?.refreshAgents()));
          else {
            agents[index] = { ...agents[index]!, ...changed };
            drawTree();
            if (infoFor.includes(`:${changed.slug}:`)) (infoFor = ""), drawInfo();
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
            infoFor = "";
            drawInfo();
          }
          drawTree();
          if (t.status === "waiting_user" || (payload as { previous?: string }).previous === "waiting_user") void refreshNeeds();
          break;
        }
        // A thread started or ended: the threads under each agent follow.
        case "session.started":
        case "session.exit":
        case "session.titled":
        case "task.created":
          clearTimeout(threadsTimer);
          threadsTimer = setTimeout(() => void listAgents().then((all) => ((agents = all), drawTree(), drawThreadHead(), centre.kind === "thread" && drawInfo())), event.kind === "session.titled" ? 200 : 1500);
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
      disposeCentre();
      mainChat?.dispose();
    },
    refresh: () => void load().then(() => show(centre)),
  };
}
