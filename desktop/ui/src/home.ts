import {
  agent as fetchAgent, agents as listAgents, automations as listAutomations, baseUrl, follow, messageAgent, messages as listMessages, modules as listModules, needs as listNeeds, pai as paiStatus,
  sendPai, status, taskItems, usage,
} from "./api.ts";
import { board, type Board } from "./board.ts";
import { chat, type Chat, type RevealTarget } from "./chat.ts";
import { ago, clear, el, modelName } from "./dom.ts";
import { icon } from "./icons.ts";
import { kindIcon } from "./kinds.ts";
import { markdown } from "./markdown.ts";
import { linkTo, navigate } from "./router.ts";
import { usageStats } from "./rings.ts";
import type { Agent, AgentStatus, Automation, LogMessage, ModuleInfo, Need, TaskItem } from "./types.ts";

/**
 * The landing view: the agents on the left, the main chat with pai in the centre (or an
 * agent's thread, or the board), and on the right what is going on — usage, modules,
 * routines, the last events — with what waits on the user stacked at the bottom.
 */

const PAI = "pai";
const STATUS: Record<AgentStatus, { dot: string; label: string }> = {
  working: { dot: "busy", label: "working" },
  waiting: { dot: "waiting", label: "waiting on you" },
  queued: { dot: "queued", label: "queued" },
  idle: { dot: "idle", label: "idle" },
  closed: { dot: "dead", label: "closed" },
};
const KIND_ORDER: Record<Agent["kind"], number> = { orchestrator: 0, standing: 1, service: 2, sub: 3 };
const money = (usd: number) => `$${usd.toFixed(usd >= 10 ? 0 : 2)}`;
const firstLine = (text: string) => text.replace(/^\[[^\]]+\]\s*/, "").split("\n").find((l) => l.trim()) ?? "";

export type Centre = { kind: "chat" } | { kind: "agent"; slug: string } | { kind: "board"; slug?: string };

export function home(root: HTMLElement) {
  let agents: Agent[] = [];
  let tasks: TaskItem[] = [];
  let needs: Need[] = [];
  let paiLog: LogMessage[] = [];
  let centre: Centre = { kind: "chat" };
  let mainChat: Chat | undefined;
  let agentChat: { slug: string; chat: Chat } | undefined;
  let theBoard: Board | undefined;
  let showClosed = false;
  let loaded = false;

  const agentsPane = el("aside.home-agents");
  const centrePane = el("section.home-centre");
  const statusPane = el("div.home-status");
  const pendingPane = el("div.home-pending");
  clear(root, agentsPane, centrePane, el("aside.home-right", {}, statusPane, pendingPane));

  const bySlug = (slug: string) => agents.find((a) => a.slug === slug);
  const nameOf = (slug: string) => (slug === "user" ? "you" : (bySlug(slug)?.name ?? slug));

  const ctx = {
    agents: () => agents,
    openAgent: (slug: string, at?: number) => {
      if (slug === PAI) return void navigate("home");
      if (at !== undefined) pendingReveal = { messageId: at };
      navigate({ name: "agents", param: slug });
      if (pendingReveal && agentChat?.slug === slug) {
        const target = pendingReveal;
        pendingReveal = undefined;
        agentChat.chat.reveal(target);
      }
    },
    openBoard: (slug: string) => navigate(slug === PAI ? "board" : { name: "board", param: slug }),
  };
  /** A row to scroll to once the thread that holds it has loaded. */
  let pendingReveal: RevealTarget | undefined;

  // ---- the agents column -----------------------------------------------------------------

  function ordered() {
    const known = new Set(agents.map((a) => a.slug));
    const children = new Map<string | null, Agent[]>();
    for (const a of agents) {
      const parent = a.parent && known.has(a.parent) ? a.parent : null;
      children.set(parent, [...(children.get(parent) ?? []), a]);
    }
    const out: { agent: Agent; depth: number }[] = [];
    const walk = (parent: string | null, depth: number) => {
      const list = (children.get(parent) ?? []).sort((x, y) => Number(x.status === "closed") - Number(y.status === "closed") || KIND_ORDER[x.kind] - KIND_ORDER[y.kind] || x.name.localeCompare(y.name));
      for (const agent of list) {
        const shown = showClosed || agent.status !== "closed" || agent.slug === selectedSlug();
        if (shown) out.push({ agent, depth });
        walk(agent.slug, shown ? depth + 1 : depth);
      }
    };
    walk(null, 0);
    return out;
  }

  const selectedSlug = () => (centre.kind === "agent" ? centre.slug : centre.kind === "board" ? (centre.slug ?? PAI) : PAI);

  /** One line of what an agent is at: the latest word between it and pai, else its task in hand. */
  function doing(agent: Agent) {
    for (let i = paiLog.length - 1; i >= 0; i -= 1) {
      const m = paiLog[i]!;
      if ((m.kind === "delegate" && m.to === agent.slug) || (m.kind === "report" && m.from === agent.slug)) return `${m.kind === "delegate" ? "→" : "←"} ${firstLine(m.body)}`;
    }
    const task = tasks.find((t) => t.owner === agent.slug && t.status === "active") ?? tasks.find((t) => t.owner === agent.slug);
    return task ? task.title : agent.brief ? firstLine(agent.brief) : "";
  }

  function drawAgents() {
    const rows = ordered().map(({ agent, depth }) => {
      const status = STATUS[agent.status] ?? STATUS.idle;
      const open = tasks.filter((t) => t.owner === agent.slug).length;
      const waiting = needs.filter((n) => n.agent === agent.slug || (agent.slug === PAI && n.agent === null)).length;
      const on = agent.slug === selectedSlug() && centre.kind !== "board";
      return el(
        "button.agent-row.rich",
        {
          class: `agent-row rich${on ? " on" : ""}${agent.status === "closed" ? " closed" : ""}`,
          style: `padding-left: ${10 + depth * 14}px`,
          title: [`${agent.name} · ${agent.kind}`, status.label + (agent.queued ? ` · ${agent.queued} queued` : ""), agent.model ? modelName(agent.model) : ""].filter(Boolean).join("\n"),
          onclick: () => (agent.slug === PAI ? navigate("home") : ctx.openAgent(agent.slug)),
        },
        el("span", { class: `dot ${status.dot}` }),
        el(
          "span.agent-text",
          {},
          el("span.agent-name", {}, el("span.label", {}, agent.name), waiting ? el("span.badge.ask", { title: `${waiting} waiting on you` }, String(waiting)) : undefined, open ? el("span.badge", { title: `${open} open task${open === 1 ? "" : "s"}` }, String(open)) : undefined),
          el("span.dim.ellipsis.agent-doing", {}, doing(agent) || status.label),
        ),
      );
    });
    clear(
      agentsPane,
      el(
        "header.panel-head",
        {},
        icon("users", 13),
        el("h2", {}, "Agents"),
        el("span.grow"),
        linkTo("board", el("a.iconbtn.slim", { title: "the board", class: `iconbtn slim${centre.kind === "board" ? " on" : ""}` }, icon("board", 12)) as HTMLAnchorElement),
        el("button.iconbtn.slim", { title: "show closed agents", class: `iconbtn slim${showClosed ? " on" : ""}`, onclick: () => ((showClosed = !showClosed), drawAgents()) }, icon("power", 12)),
      ),
      el("div.home-agent-list", {}, ...(rows.length ? rows : [el("p.hint", {}, "No agents yet.")])),
    );
  }

  // ---- the centre ------------------------------------------------------------------------

  function liveSession() {
    return paiStatus()
      .then((p) => p.session?.sessionId)
      .catch(() => undefined);
  }

  function disposeCentre() {
    agentChat?.chat.dispose();
    agentChat = undefined;
    theBoard?.dispose();
    theBoard = undefined;
  }

  function showMain() {
    mainChat ??= chat({ agent: PAI, parent: "user", live: liveSession, send: (text) => sendPai(text), placeholder: "Message pai…" }, ctx);
    clear(
      centrePane,
      el("header.panel-head", {}, icon("bot", 13), el("h2", {}, "pai"), el("span.dim", {}, "the main chat"), el("span.grow"), mainChat.toolsToggle),
      mainChat.node,
    );
    mainChat.focus();
  }

  async function showAgent(slug: string) {
    const existing = bySlug(slug);
    const head = el("header.panel-head.agent-head");
    const brief = el("div.agent-brief", { hidden: true });
    const thread = chat({ agent: slug, parent: existing?.parent ?? PAI, send: (text) => messageAgent(slug, text), placeholder: `Message ${existing?.name ?? slug}…` }, ctx);
    agentChat = { slug, chat: thread };
    clear(centrePane, head, brief, thread.node);
    const draw = (agent: Agent) => {
      const status = STATUS[agent.status] ?? STATUS.idle;
      const crumbs = (agent.breadcrumb ?? agent.name).split(" › ");
      const chain = [PAI, ...lineage(agent.slug).map((a) => a.slug)];
      clear(
        head,
        icon("user", 13),
        el(
          "nav.crumbs",
          {},
          ...crumbs.flatMap((name, i) => [
            i ? el("span.crumb-sep", {}, "›") : undefined,
            el("button.crumb", { class: `crumb${i === crumbs.length - 1 ? " on" : ""}`, onclick: () => (i === 0 ? navigate("home") : ctx.openAgent(chain[i] ?? agent.slug)) }, name),
          ]),
        ),
        el("span.tag", { class: `tag status-${agent.status}` }, status.label),
        el("span.tag", {}, agent.kind),
        agent.model ? el("span.tag.model", {}, modelName(agent.model)) : undefined,
        el("span.grow"),
        el("span.dim", { title: "turns today · what it has cost" }, `${agent.turnsToday} turns · ${money(agent.costUsd)}`),
        thread.toolsToggle,
      );
      const own = tasks.filter((t) => t.owner === agent.slug);
      brief.hidden = !agent.brief && !own.length;
      clear(
        brief,
        agent.brief ? el("p.staff-brief-text", { title: agent.brief, onclick: (e: Event) => (e.currentTarget as HTMLElement).classList.toggle("open") }, agent.brief) : undefined,
        own.length ? el("div.chips", {}, ...own.map((t) => el("button.chip", { title: `${t.status} · open on the board`, onclick: () => ctx.openBoard(agent.slug) }, icon("board", 10), t.title))) : undefined,
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

  const lineage = (slug: string) => {
    const chain: Agent[] = [];
    for (let a = bySlug(slug); a && a.slug !== PAI && !chain.includes(a); a = a.parent ? bySlug(a.parent) : undefined) chain.unshift(a);
    return chain;
  };

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
    drawAgents();
  }

  // ---- the right column: status and what waits -------------------------------------------

  const usageBox = el("section.status-block.usage");
  const modulesBox = el("section.status-block.modules");
  const routinesBox = el("section.status-block.routines");
  const eventsBox = el("section.status-block.events");
  clear(statusPane, usageBox, modulesBox, routinesBox, eventsBox);
  const block = (title: string, ...body: (Node | undefined | false)[]) => [el("h3.status-title", {}, title), ...body];

  async function drawUsage() {
    try {
      const data = await usage();
      clear(usageBox, ...block("Usage", el("div.usage-row", {}, ...usageStats(data, true))));
    } catch {
      clear(usageBox, ...block("Usage", el("p.hint", {}, "offline")));
    }
  }

  async function drawModules() {
    const [mods, health] = await Promise.all([listModules().catch(() => [] as ModuleInfo[]), status().catch(() => undefined)]);
    const withUi = mods.filter((m) => typeof m.ui === "string");
    const links = [
      linkTo("editor", el("a.status-link", {}, icon("code", 12), el("span", {}, "Editor"), el("span.dim", {}, "files, threads, terminals")) as HTMLAnchorElement),
      health?.editor.url ? el("a.status-link", { href: health.editor.url, target: "_blank", rel: "noreferrer" }, icon("external", 12), el("span", {}, "VS Code"), el("span.dim", {}, "code-server")) : undefined,
      ...withUi.map((m) => el("a.status-link", { href: `${baseUrl()}${m.ui}`, target: "_blank", rel: "noreferrer", title: m.description }, icon("zap", 12), el("span", {}, m.title), el("span.dim", {}, String((m.status as { health?: string }).health ?? "")))),
      linkTo("dashboard", el("a.status-link", {}, icon("layout", 12), el("span", {}, "Dashboard"), el("span.dim", {}, "modules, context, settings")) as HTMLAnchorElement),
    ];
    clear(modulesBox, ...block("Modules", el("div.status-links", {}, ...links)));
  }

  async function drawRoutines() {
    const routines = await listAutomations().catch(() => [] as Automation[]);
    const on = routines.filter((r) => r.enabled);
    const recent = on
      .filter((r) => r.lastRun)
      .sort((a, b) => (b.lastRun ?? 0) - (a.lastRun ?? 0))
      .slice(0, 5);
    const rows = (recent.length ? recent : on.slice(0, 5)).map((r) =>
      el("div.status-row", { title: `${r.event}${r.filter ? ` · ${r.filter}` : ""} → ${r.action}` }, icon("clock", 11), el("span.ellipsis", {}, r.name), el("span.dim", {}, r.lastRun ? ago(r.lastRun) : "never")),
    );
    clear(routinesBox, ...block(`Routines`, el("span.dim.status-sub", {}, `${on.length} on · ${routines.length - on.length} off`), ...(rows.length ? rows : [el("p.hint", {}, "No routines.")])));
  }

  function drawEvents() {
    const events = paiLog.filter((m) => m.kind === "event").slice(-10).reverse();
    const rows = events.map((m) => {
      const row = el(
        "button.status-row.event",
        { class: `status-row event${m.meta.event === "error" ? " error" : ""}`, title: m.body, onclick: () => mainChat?.reveal({ messageId: m.id }) || navigate("home") },
        kindIcon(m.meta.event ?? "event", 11),
        el("span.ellipsis", {}, firstLine(m.body)),
        el("span.dim", {}, ago(m.createdAt)),
      );
      return row;
    });
    clear(eventsBox, ...block("Events", ...(rows.length ? rows : [el("p.hint", {}, "Nothing yet.")])));
  }

  /** The stack of what waits on the user: a card each, newest on top; a click finds it in the chat. */
  function drawPending() {
    const cards = needs.map((n) => {
      const agentSlug = n.agent ?? PAI;
      const card = el(
        "button.pending-card",
        {
          class: `pending-card ${n.kind}${n.priority !== "normal" ? ` prio-${n.priority}` : ""}`,
          title: "find it in the chat",
          onclick: () => reveal(n),
        },
        el("span.pending-meta", {}, kindIcon(n.kind === "task" ? "notice" : n.kind === "ask" ? "ask" : "question", 11), el("b", {}, n.agent ? n.from || nameOf(agentSlug) : "pai"), n.taskId ? el("span.tag", {}, `#${n.taskId}`) : undefined, el("span.grow"), el("span.dim", {}, ago(n.createdAt))),
        el("span.pending-text", {}, markdown(firstLine(n.question))),
        n.options.length ? el("span.dim.ellipsis", {}, n.options.join(" · ")) : undefined,
      );
      return card;
    });
    clear(
      pendingPane,
      el("h3.status-title", {}, "Waiting on you", needs.length ? el("span.badge.ask", {}, String(needs.length)) : undefined),
      el("div.pending-stack", {}, ...(cards.length ? cards : [el("p.hint", {}, "Nothing waits on you.")])),
    );
  }

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

  // ---- loading and following --------------------------------------------------------------

  async function refreshNeeds() {
    needs = await listNeeds().catch(() => needs);
    drawPending();
    drawAgents();
  }

  async function load() {
    [agents, tasks, needs, paiLog] = await Promise.all([listAgents().catch(() => [] as Agent[]), taskItems().catch(() => [] as TaskItem[]), listNeeds().catch(() => [] as Need[]), listMessages(PAI, { limit: 200 }).catch(() => [] as LogMessage[])]);
    drawAgents();
    drawPending();
    drawEvents();
    void drawUsage();
    void drawModules();
    void drawRoutines();
  }

  const stop = follow(
    undefined,
    (event) => {
      const payload = event.payload;
      switch (event.kind) {
        case "message.new": {
          const m = payload as unknown as LogMessage;
          if (m.from === PAI || m.to === PAI || m.meta.agent === PAI) {
            paiLog.push(m);
            if (paiLog.length > 400) paiLog = paiLog.slice(-300);
            if (m.kind === "event") drawEvents();
            if (m.kind === "delegate" || m.kind === "report") drawAgents();
          }
          if (m.kind === "ask" || m.kind === "answer") void refreshNeeds();
          break;
        }
        case "agent.changed":
        case "agent.created": {
          const changed = payload as unknown as Agent;
          const index = agents.findIndex((a) => a.slug === changed.slug);
          if (index < 0) void listAgents().then((all) => ((agents = all), drawAgents(), mainChat?.refreshAgents(), theBoard?.refreshAgents()));
          else {
            agents[index] = { ...agents[index]!, ...changed };
            drawAgents();
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
          drawAgents();
          if (t.status === "waiting_user" || (payload as { previous?: string }).previous === "waiting_user") void refreshNeeds();
          break;
        }
        case "session.question":
        case "session.answer":
        case "ask.created":
        case "ask.answered":
          void refreshNeeds();
          break;
        case "automation.fired":
        case "routine.fired":
          void drawRoutines();
          break;
      }
    },
    { replay: false },
  );
  const usageTimer = setInterval(() => void drawUsage(), 60_000);
  window.addEventListener("pai:prefs", () => void drawUsage());

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
    /** The main chat's box, for keyboard focus. */
    focus: () => (centre.kind === "chat" ? mainChat?.focus() : agentChat?.chat.focus()),
    dispose() {
      stop();
      clearInterval(usageTimer);
      disposeCentre();
      mainChat?.dispose();
    },
    refresh: () => void load().then(() => show(centre)),
  };
}
