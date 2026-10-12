import { agent as fetchAgent, agents as listAgents, follow, messageAgent, needs as listNeeds, pai as paiStatus, reconfigure, sendPai, taskItems } from "./api.ts";
import { board, type Board } from "./board.ts";
import { chat, type Chat, type RevealTarget } from "./chat.ts";
import { clear, el, modelName } from "./dom.ts";
import { needsButton } from "./needs.ts";
import { projectPeek } from "./peek.ts";
import { projectTree, type TreeRow } from "./ptree.ts";
import { navigate } from "./router.ts";
import type { Agent, AgentStatus, Effort, LogMessage, Need, SessionSummary, TaskItem } from "./types.ts";

/**
 * The main view: the projects on the left (each one an agent, nested as the agents are), the
 * chat in the middle — pai's own, an agent's thread, or the board — and above the box the hand
 * with what waits on the user. Nothing else: usage sits in the box, the rest is in settings.
 */

const PAI = "pai";
const STATUS: Record<AgentStatus, string> = { working: "working", waiting: "waiting on you", queued: "queued", idle: "idle", closed: "closed" };
const KIND_ORDER: Record<Agent["kind"], number> = { orchestrator: 0, standing: 1, service: 2, sub: 3 };
const money = (usd: number) => `$${usd.toFixed(usd >= 10 ? 0 : 2)}`;

export type Centre = { kind: "chat" } | { kind: "agent"; slug: string } | { kind: "board"; slug?: string };

export function home(root: HTMLElement) {
  let agents: Agent[] = [];
  let tasks: TaskItem[] = [];
  let needs: Need[] = [];
  /** pai's live session as last seen: its id, model and effort. */
  let paiSession: SessionSummary | undefined;
  let centre: Centre = { kind: "chat" };
  let mainChat: Chat | undefined;
  let agentChat: { slug: string; chat: Chat } | undefined;
  let theBoard: Board | undefined;
  let loaded = false;
  /** A row to scroll to once the thread that holds it has loaded. */
  let pendingReveal: RevealTarget | undefined;

  const sidePane = el("aside.home-side");
  const centrePane = el("section.home-centre");
  clear(root, sidePane, centrePane);

  const bySlug = (slug: string) => agents.find((a) => a.slug === slug);
  const nameOf = (slug: string) => (slug === "user" ? "you" : slug === PAI ? "General" : (bySlug(slug)?.name ?? slug));

  const ctx = {
    agents: () => agents,
    openAgent: (slug: string, at?: number) => {
      if (slug === PAI) return void navigate("home");
      if (at !== undefined) pendingReveal = { messageId: at };
      navigate({ name: "chat", param: slug });
      if (pendingReveal && agentChat?.slug === slug) {
        const target = pendingReveal;
        pendingReveal = undefined;
        agentChat.chat.reveal(target);
      }
    },
    openBoard: (slug: string) => navigate(slug === PAI ? "board" : { name: "board", param: slug }),
  };

  // ---- the hand ------------------------------------------------------------------------------

  const hand = needsButton({ nameOf: (n) => (n.agent ? n.from || nameOf(n.agent) : "pai"), reveal });

  /** Where a need lives: pai's questions and tasks in the main chat, an agent's ask in its thread. */
  function reveal(n: Need) {
    const target: RevealTarget = n.kind === "ask" ? { askId: n.askId } : n.kind === "task" ? { taskId: n.taskId } : { question: true };
    const inMain = n.agent === null || n.agent === PAI;
    if (inMain) {
      if (centre.kind !== "chat") navigate("home");
      if (!mainChat?.reveal(target) && n.kind === "task" && n.taskId) navigate({ name: "board", param: n.agent ?? PAI });
      return;
    }
    if (agentChat?.slug === n.agent && agentChat.chat.reveal(target)) return;
    pendingReveal = target;
    ctx.openAgent(n.agent!);
  }

  // ---- the tree ------------------------------------------------------------------------------

  const selectedSlug = () => (centre.kind === "agent" ? centre.slug : centre.kind === "board" ? (centre.slug ?? PAI) : PAI);
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
    const out: TreeRow[] = [];
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
  const peek = projectPeek({ needsOf });
  const drawTree = () => projectTree(sidePane, treeRows(), (slug) => ctx.openAgent(slug), peek.attach);

  // ---- the centre ----------------------------------------------------------------------------

  const liveSession = () =>
    paiStatus()
      .then((p) => ((paiSession = p.session), mainChat?.refreshPrefs(), p.session?.sessionId))
      .catch(() => undefined);
  const paiPrefs = () => (paiSession ? { model: paiSession.modelPref ?? paiSession.model, effort: paiSession.effort } : undefined);
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

  function showMain() {
    mainChat ??= chat({ agent: PAI, parent: "user", title: "General", live: liveSession, prefs: paiPrefs, setPrefs: setPaiPrefs, send: (text) => sendPai(text), placeholder: "Message pai…" }, ctx);
    mainChat.slot.append(hand.node);
    clear(centrePane, mainChat.node);
    mainChat.focus();
  }

  const lineage = (slug: string) => {
    const chain: Agent[] = [];
    for (let a = bySlug(slug); a && a.slug !== PAI && !chain.includes(a); a = a.parent ? bySlug(a.parent) : undefined) chain.unshift(a);
    return chain;
  };

  async function showAgent(slug: string) {
    const existing = bySlug(slug);
    const thread = chat({ agent: slug, parent: existing?.parent ?? PAI, title: existing?.name ?? slug, prefs: () => (bySlug(slug)?.model ? { model: bySlug(slug)!.model } : undefined), send: (text) => messageAgent(slug, text), placeholder: `Message ${existing?.name ?? slug}…` }, ctx);
    agentChat = { slug, chat: thread };
    thread.slot.append(hand.node);
    clear(centrePane, thread.node);
    const draw = (agent: Agent) => {
      const crumbs = lineage(agent.slug).map((a) => a.name);
      thread.setHead(
        crumbs.join(" › ") || agent.name,
        el(
          "span.tags",
          {},
          el("span", { class: `tag status-${agent.status}` }, STATUS[agent.status] ?? "idle"),
          el("span.tag", {}, agent.kind),
          agent.model ? el("span.tag", {}, modelName(agent.model)) : undefined,
          el("span.tag", { title: "turns today · what it has cost" }, `${agent.turnsToday} turns · ${money(agent.costUsd)}`),
        ),
      );
      if (agent.status === "closed") thread.node.querySelector<HTMLTextAreaElement>("textarea")?.setAttribute("disabled", "");
    };
    if (existing) draw(existing);
    const full = await fetchAgent(slug).catch(() => undefined);
    if (full && agentChat?.slug === slug) draw(full);
    if (agentChat?.slug !== slug) return;
    if (pendingReveal) {
      const target = pendingReveal;
      pendingReveal = undefined;
      setTimeout(() => thread.reveal(target), 400);
    }
  }

  function showBoard(slug?: string) {
    theBoard = board(slug, { agents: () => agents, openAgent: ctx.openAgent, onSelect: (s) => navigate(s === PAI ? "board" : { name: "board", param: s }, true) });
    clear(centrePane, theBoard.node);
  }

  function show(next: Centre) {
    const sameAgent = next.kind === "agent" && agentChat?.slug === next.slug;
    const sameBoard = next.kind === "board" && theBoard;
    centre = next;
    if (sameBoard) theBoard!.select(next.slug ?? PAI);
    else if (!sameAgent) {
      disposeCentre();
      if (next.kind === "chat") showMain();
      else if (next.kind === "agent") void showAgent(next.slug);
      else showBoard(next.slug);
    }
    if (next.kind !== "chat" && mainChat) mainChat.node.remove();
    root.classList.toggle("board-mode", next.kind === "board");
    drawTree();
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
          drawTree();
          if (t.status === "waiting_user" || (payload as { previous?: string }).previous === "waiting_user") void refreshNeeds();
          break;
        }
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
