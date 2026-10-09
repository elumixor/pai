import {
  agents as listAgents, answerAsk, asks as listAsks, closeAgent, createTask, follow, messageAgent, messages as listMessages, routines as listRoutines, taskItems, updateTask,
} from "./api.ts";
import { ago, clear, el, modelName } from "./dom.ts";
import { icon, type IconName } from "./icons.ts";
import { markdown } from "./markdown.ts";
import { navigate } from "./router.ts";
import { save, state } from "./state.ts";
import type { Agent, AgentStatus, Ask, LogMessage, MessageKind, Routine, TaskItem, TaskStatus } from "./types.ts";

/**
 * The staff: pai and the agents it runs, as a tree; one agent's chat — the message log
 * filtered to it — with a box to write to it; and beside the chat what waits on the user
 * (asks) and the task list. All of it follows the event stream while the page is open.
 */

const PAI = "pai";
const PAGE = 100;
/** A run of this many event rows in a row folds into one line. */
const FOLD = 3;

const STATUS: Record<AgentStatus, { dot: string; label: string }> = {
  working: { dot: "busy", label: "working" },
  waiting: { dot: "waiting", label: "waiting on you" },
  queued: { dot: "queued", label: "queued" },
  idle: { dot: "idle", label: "idle" },
  closed: { dot: "dead", label: "closed" },
};
const KIND_ORDER: Record<Agent["kind"], number> = { orchestrator: 0, standing: 1, service: 2, sub: 3 };

const TASK_STATUS: Partial<Record<TaskStatus, string>> = {
  waiting_user: "Waiting on you",
  active: "Active",
  inbox: "Inbox",
  waiting_other: "Waiting on others",
  scheduled: "Scheduled",
};

const KIND_ICON: Record<MessageKind, IconName> = {
  chat: "message", delegate: "delegate", report: "reply", request: "arrows", response: "arrows", ask: "help", answer: "check", notice: "bell", event: "zap",
};
const EVENT_ICON: Record<string, IconName> = {
  "agent.created": "bot", "agent.spawned": "bot", "agent.woken": "zap", "agent.closed": "power", "routine.fired": "clock",
  "item.arrived": "inbox", "calendar.upcoming": "calendar", answered: "check", sent: "send", error: "alert",
};

/** What a folded run counts an event as: "2 routines, 3 emails". */
function eventNoun(m: LogMessage): readonly [string, string] {
  switch (m.meta.event) {
    case "routine.fired":
      return ["routine", "routines"];
    case "item.arrived": {
      const source = m.meta.source ?? "";
      if (/mail/i.test(source)) return ["email", "emails"];
      if (/linkedin/i.test(source)) return ["LinkedIn message", "LinkedIn messages"];
      if (/telegram|tg/i.test(source)) return ["Telegram message", "Telegram messages"];
      if (/github/i.test(source)) return ["GitHub notification", "GitHub notifications"];
      return ["item", "items"];
    }
    case "calendar.upcoming":
      return ["meeting", "meetings"];
    case "agent.created":
    case "agent.spawned":
      return ["agent started", "agents started"];
    case "agent.woken":
      return ["wake-up", "wake-ups"];
    case "agent.closed":
      return ["agent closed", "agents closed"];
    case "answered":
      return ["answer", "answers"];
    case "sent":
      return ["sent", "sent"];
    case "error":
      return ["error", "errors"];
    default:
      return ["event", "events"];
  }
}

function foldSummary(rows: LogMessage[]) {
  const counts = new Map<string, { n: number; noun: readonly [string, string] }>();
  for (const row of rows) {
    const noun = eventNoun(row);
    const entry = counts.get(noun[1]) ?? { n: 0, noun };
    entry.n += 1;
    counts.set(noun[1], entry);
  }
  return `${rows.length} events: ${[...counts.values()].map(({ n, noun }) => `${n} ${n === 1 ? noun[0] : noun[1]}`).join(", ")}`;
}

const concerns = (m: LogMessage, slug: string) => m.from === slug || m.to === slug || m.meta.agent === slug;
const time = (at: number) => el("time", { title: new Date(at).toLocaleString() }, ago(at));
const money = (usd: number) => `$${usd.toFixed(usd >= 10 ? 0 : 2)}`;

/** One group of the log: a message on its own, or a run of event rows (folded from three on). */
interface Group {
  readonly rows: LogMessage[];
  node: HTMLElement;
  open?: boolean;
}
const isEvents = (group: Group) => group.rows[0]?.kind === "event";

export function staff(root: HTMLElement) {
  let agents: Agent[] = [];
  let asks: Ask[] = [];
  let tasks: TaskItem[] | undefined;
  let routines: Routine[] = [];
  let selected = state.agent ?? PAI;
  let showClosed = false;
  let onlySelected = false;

  const bySlug = (slug: string) => agents.find((a) => a.slug === slug);
  const lineage = (slug: string) => {
    const chain: Agent[] = [];
    for (let a = bySlug(slug); a && !chain.includes(a); a = a.parent ? bySlug(a.parent) : undefined) chain.unshift(a);
    return chain;
  };
  /** A party as a person reads it: you, an agent's name, a routine, a watcher. */
  const who = (party: string) => {
    if (party === "user") return "you";
    const agent = bySlug(party);
    if (agent) return agent.name;
    const routine = /^routine:(\d+)$/.exec(party);
    if (routine) return routines.find((r) => r.id === Number(routine[1]))?.name ?? `routine #${routine[1]}`;
    return party.replace(/^watcher:/, "");
  };
  const party = (slug: string) =>
    bySlug(slug) ? el("button.party", { title: `open ${who(slug)}`, onclick: () => select(slug) }, who(slug)) : el("span.party", {}, who(slug));
  const openAsk = (id: number | undefined) => (id === undefined ? undefined : asks.find((a) => a.id === id));

  const treePane = el("aside.staff-tree");
  const chatPane = el("section.staff-chat");
  const sidePane = el("aside.staff-side");
  clear(root, el("div.staff", {}, treePane, chatPane, sidePane));

  // ---- the tree ---------------------------------------------------------------------------

  const treeList = el("div.staff-tree-list");
  clear(
    treePane,
    el(
      "header.panel-head",
      {},
      icon("users", 13),
      el("h2", {}, "Staff"),
      el("span.grow"),
      el(
        "button.iconbtn.slim",
        {
          title: "show closed agents",
          onclick: (event: Event) => {
            showClosed = !showClosed;
            (event.currentTarget as HTMLElement).classList.toggle("on", showClosed);
            drawTree();
          },
        },
        icon("power", 12),
      ),
      el("button.iconbtn.slim", { title: "refresh", onclick: () => void loadAll() }, icon("refresh", 12)),
    ),
    treeList,
  );

  /** Every agent under its parent, open ones before closed, then by kind and name. */
  function ordered() {
    const known = new Set(agents.map((a) => a.slug));
    const children = new Map<string | null, Agent[]>();
    for (const a of agents) {
      const parent = a.parent && known.has(a.parent) ? a.parent : null;
      children.set(parent, [...(children.get(parent) ?? []), a]);
    }
    const out: { agent: Agent; depth: number }[] = [];
    const walk = (parent: string | null, depth: number) => {
      const list = (children.get(parent) ?? []).sort(
        (x, y) => Number(x.status === "closed") - Number(y.status === "closed") || KIND_ORDER[x.kind] - KIND_ORDER[y.kind] || x.name.localeCompare(y.name),
      );
      for (const agent of list) {
        // A closed agent is left out unless asked for; whatever still runs under it moves up a level.
        const shown = showClosed || agent.status !== "closed";
        if (shown) out.push({ agent, depth });
        walk(agent.slug, shown ? depth + 1 : depth);
      }
    };
    walk(null, 0);
    return out;
  }

  const openTasksOf = (agent: Agent) => (tasks ? tasks.filter((t) => t.owner === agent.slug).length : (agent.openTasks ?? 0));

  function drawTree() {
    const rows = ordered().map(({ agent, depth }) => {
      const status = STATUS[agent.status] ?? STATUS.idle;
      const waiting = asks.filter((a) => a.agent === agent.slug).length;
      const open = openTasksOf(agent);
      return el(
        "button.agent-row",
        {
          class: `agent-row${agent.slug === selected ? " on" : ""}${agent.status === "closed" ? " closed" : ""}`,
          style: `padding-left: ${10 + depth * 14}px`,
          title: [`${agent.name} · ${agent.kind}`, status.label + (agent.queued ? ` · ${agent.queued} queued` : ""), agent.brief, agent.model ? modelName(agent.model) : ""].filter(Boolean).join("\n"),
          onclick: () => select(agent.slug),
        },
        el("span", { class: `dot ${status.dot}` }),
        el("span.label", {}, agent.name),
        waiting ? el("span.badge.ask", { title: `${waiting} question${waiting === 1 ? "" : "s"} for you` }, `?${waiting}`) : undefined,
        open ? el("span.badge", { title: `${open} open task${open === 1 ? "" : "s"}` }, String(open)) : undefined,
        el("span.agent-stats", { title: "turns today · cost" }, `${agent.turnsToday}t · ${money(agent.costUsd)}`),
      );
    });
    clear(treeList, ...(rows.length ? rows : [el("p.hint", {}, "No agents yet.")]));
  }

  function select(slug: string) {
    if (!bySlug(slug)) return;
    selected = slug;
    state.agent = slug;
    save();
    drawTree();
    void openChat();
    drawSide();
  }

  // ---- one agent's chat -------------------------------------------------------------------

  const head = el("header.panel-head.staff-head");
  const briefBar = el("div.staff-brief");
  const log = el("div.staff-log");
  const input = el("textarea", { rows: 1, placeholder: "Message…", spellcheck: false }) as HTMLTextAreaElement;
  const note = el("span.note");
  const sendButton = el("button.iconbtn", { title: "send (enter)", onclick: () => void submit() }, icon("send", 14));
  clear(
    chatPane,
    head,
    briefBar,
    log,
    el("footer.staff-compose", {}, el("div.compose-row", {}, input, sendButton), el("div.compose-foot", {}, note, el("span.grow"), el("span.dim", {}, "enter to send · shift+enter newline"))),
  );

  let groups: Group[] = [];
  let rows: LogMessage[] = [];
  const seen = new Set<number>();
  let more = false;
  let chatToken = 0;

  const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  const scroll = () => (log.scrollTop = log.scrollHeight);
  const grow = () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(160, input.scrollHeight)}px`;
  };

  function drawHead() {
    const agent = bySlug(selected);
    if (!agent) return clear(head);
    const chain = lineage(selected);
    const crumbs = chain.flatMap((a, i) => [
      i ? el("span.crumb-sep", {}, "›") : undefined,
      el("button.crumb", { class: `crumb${a.slug === selected ? " on" : ""}`, onclick: () => select(a.slug) }, a.name),
    ]);
    const status = STATUS[agent.status] ?? STATUS.idle;
    clear(
      head,
      icon(agent.kind === "orchestrator" ? "bot" : "user", 13),
      el("nav.crumbs", {}, ...crumbs.filter((c): c is HTMLElement => Boolean(c))),
      el("span.tag", { class: `tag status-${agent.status}`, title: agent.queued ? `${agent.queued} queued` : "" }, status.label),
      el("span.tag", { title: "what kind of agent" }, agent.kind),
      agent.model ? el("span.tag.model", { title: agent.model }, modelName(agent.model)) : undefined,
      agent.unresolvedTools?.length
        ? el("span.tag.warn", { title: `declared for it, but no MCP server here provides it: ${agent.unresolvedTools.join(", ")}` }, `no server for ${agent.unresolvedTools.join(", ")}`)
        : undefined,
      el("span.grow"),
      el("span.dim", { title: "turns today · what it has cost" }, `${agent.turnsToday} turns · ${money(agent.costUsd)}`),
      agent.slug !== PAI && agent.status !== "closed"
        ? el(
            "button.iconbtn",
            {
              title: `close ${agent.name}`,
              onclick: async () => {
                if (!confirm(`Close ${agent.name}? It stops and reports back to ${who(agent.parent ?? PAI)}.`)) return;
                const result = await closeAgent(agent.slug);
                note.textContent = result.error ?? (result.queued ? "queued — sent when the daemon answers" : "");
              },
            },
            icon("power", 13),
          )
        : undefined,
    );
    const own = routines.filter((r) => r.agent === agent.slug || r.owner === agent.slug);
    briefBar.hidden = !agent.brief && !own.length;
    clear(
      briefBar,
      agent.brief ? el("p.staff-brief-text", { title: agent.brief, onclick: (e: Event) => (e.currentTarget as HTMLElement).classList.toggle("open") }, agent.brief) : undefined,
      own.length
        ? el(
            "div.chips",
            {},
            ...own.map((r) =>
              el(
                "span.chip",
                { class: `chip${r.enabled ? "" : " off"}`, title: `${r.schedule ? `schedule ${r.schedule}` : `on ${r.event}`} → ${r.action}\n${r.runs ? `${r.runs}× · last ${r.lastRun ? ago(r.lastRun) : ""}` : "never ran"}` },
                icon("clock", 10),
                r.name,
              ),
            ),
          )
        : undefined,
    );
    const closed = agent.status === "closed";
    input.disabled = closed;
    sendButton.toggleAttribute("disabled", closed);
    input.placeholder = closed ? `${agent.name} is closed` : agent.slug === PAI ? "Message pai…" : `Message ${agent.name}…`;
  }

  /** A message in the log, drawn by its kind. */
  function renderMessage(m: LogMessage): HTMLElement {
    switch (m.kind) {
      case "chat": {
        const mine = m.from === "user";
        const toward = m.to !== selected && m.to !== "user" && !mine;
        return el(
          "div.msg.chat",
          { class: `msg chat${mine ? " mine" : ""}` },
          el("div.msg-meta", {}, icon(mine ? "user" : "message", 11), party(m.from), toward ? el("span.dim", {}, "→") : undefined, toward ? party(m.to) : undefined, time(m.createdAt)),
          el("div.msg-body", {}, markdown(m.body)),
        );
      }
      case "delegate":
      case "report":
      case "request":
      case "response":
        return card(m);
      case "ask":
        return askCard(m);
      case "answer":
        return el("div.msg-line.answer", {}, icon("check", 11), el("span.ellipsis", { title: m.body }, `${who(m.from)} answered: ${m.body}`), time(m.createdAt));
      case "notice":
        return el("div.msg-line.notice", {}, icon("bell", 11), el("div.msg-body", {}, markdown(m.body)), time(m.createdAt));
      default:
        return eventLine(m);
    }
  }

  /** A delegation, a report, a request or a response: who to whom, folded to a few lines until clicked. */
  function card(m: LogMessage) {
    const body = el("div.msg-body.clamped", { title: "click to expand" }, markdown(m.body));
    body.addEventListener("click", () => body.classList.toggle("clamped"));
    return el(
      "div.msg-card",
      { class: `msg-card ${m.kind}` },
      el(
        "div.msg-meta",
        {},
        icon(KIND_ICON[m.kind], 11),
        el("span.kind", {}, m.kind),
        party(m.from),
        el("span.dim", {}, "→"),
        party(m.to),
        m.taskId ? el("span.tag", { title: "the task it is about" }, `#${m.taskId}`) : undefined,
        el("span.grow"),
        time(m.createdAt),
      ),
      body,
    );
  }

  function askCard(m: LogMessage) {
    const ask = openAsk(m.meta.askId);
    return el(
      "div.msg-card.ask",
      { class: `msg-card ask${ask ? "" : " answered"}`, "data-ask": m.meta.askId ?? "" },
      el(
        "div.msg-meta",
        {},
        icon("help", 11),
        party(m.from),
        el("span.dim", {}, "asks"),
        m.meta.priority && m.meta.priority !== "normal" ? el("span.tag", { class: `tag prio-${m.meta.priority}` }, m.meta.priority) : undefined,
        el("span.grow"),
        time(m.createdAt),
      ),
      el("div.msg-body", {}, markdown(m.body)),
      ask ? answerControls(ask) : m.meta.askId !== undefined ? el("span.dim.ask-state", {}, "answered") : undefined,
    );
  }

  function eventLine(m: LogMessage) {
    const text = m.meta.link ? el("a.ellipsis", { href: m.meta.link, target: "_blank", rel: "noreferrer", title: m.body }, m.body) : el("span.ellipsis", { title: m.body }, m.body);
    return el("div.msg-event", { class: `msg-event${m.meta.event === "error" ? " error" : ""}` }, icon(EVENT_ICON[m.meta.event ?? ""] ?? "zap", 11), text, time(m.createdAt));
  }

  function renderGroup(group: Group): HTMLElement {
    if (!isEvents(group)) return renderMessage(group.rows[0]!);
    if (group.rows.length < FOLD) return el("div.msg-events", {}, ...group.rows.map(eventLine));
    const last = group.rows[group.rows.length - 1]!;
    const toggle = el(
      "button.msg-fold",
      {
        title: group.open ? "fold" : "show them",
        onclick: () => {
          group.open = !group.open;
          const fresh = renderGroup(group);
          group.node.replaceWith(fresh);
          group.node = fresh;
        },
      },
      icon("chevron", 11),
      el("span.ellipsis", {}, foldSummary(group.rows)),
      time(last.createdAt),
    );
    return el("div.msg-events", { class: `msg-events folded${group.open ? " open" : ""}` }, toggle, ...(group.open ? group.rows.map(eventLine) : []));
  }

  const grouped = (list: LogMessage[]) => {
    const out: Group[] = [];
    for (const m of list) {
      const last = out[out.length - 1];
      if (m.kind === "event" && last && isEvents(last)) last.rows.push(m);
      else out.push({ rows: [m], node: undefined as unknown as HTMLElement });
    }
    for (const group of out) group.node = renderGroup(group);
    return out;
  };

  /** Draws the whole log from `rows`; the folds that were open stay open. */
  function drawLog() {
    const opened = new Set(groups.filter((g) => g.open).map((g) => g.rows[0]!.id));
    groups = grouped(rows);
    for (const group of groups)
      if (opened.has(group.rows[0]!.id)) {
        group.open = true;
        group.node = renderGroup(group);
      }
    const earlier = more ? el("button.btn.staff-more", { onclick: () => void loadEarlier() }, "Load earlier") : undefined;
    clear(log, earlier, ...groups.map((g) => g.node), ...(rows.length ? [] : [el("p.hint", {}, "Nothing said here yet.")]));
  }

  /** A live row: joins the run of events before it, or starts a group of its own. */
  function append(m: LogMessage) {
    if (seen.has(m.id)) return;
    seen.add(m.id);
    rows.push(m);
    const stick = nearBottom();
    log.querySelector(":scope > .hint")?.remove();
    if (m.from === "user") for (const pending of log.querySelectorAll<HTMLElement>(".msg.pending")) if (pending.dataset.text === m.body.trim()) pending.remove();
    const last = groups[groups.length - 1];
    if (m.kind === "event" && last && isEvents(last)) {
      last.rows.push(m);
      const fresh = renderGroup(last);
      last.node.replaceWith(fresh);
      last.node = fresh;
    } else {
      const group: Group = { rows: [m], node: renderMessage(m) };
      groups.push(group);
      // A pending message of the user's stays last until its row arrives.
      const pending = log.querySelector(".msg.pending");
      if (pending) log.insertBefore(group.node, pending);
      else log.append(group.node);
    }
    if (stick) scroll();
  }

  async function openChat() {
    const token = ++chatToken;
    drawHead();
    groups = [];
    rows = [];
    seen.clear();
    clear(log, el("p.hint", {}, "…"));
    note.textContent = "";
    try {
      const page = await listMessages(selected, { limit: PAGE });
      if (token !== chatToken) return;
      rows = page.slice();
      for (const m of rows) seen.add(m.id);
      more = page.length >= PAGE;
      drawLog();
      scroll();
    } catch (err) {
      if (token === chatToken) clear(log, el("p.hint", {}, `Cannot load the log: ${(err as Error).message}`));
    }
  }

  async function loadEarlier() {
    const first = rows[0];
    if (!first) return;
    const older = await listMessages(selected, { before: first.id, limit: PAGE }).catch(() => []);
    const fresh = older.filter((m) => !seen.has(m.id));
    for (const m of fresh) seen.add(m.id);
    more = older.length >= PAGE;
    // The view stays where it was: what was on screen keeps its distance from the bottom.
    const fromBottom = log.scrollHeight - log.scrollTop;
    rows = [...fresh, ...rows];
    drawLog();
    log.scrollTop = log.scrollHeight - fromBottom;
  }

  async function submit() {
    const text = input.value.trim();
    if (!text || input.disabled) return;
    input.value = "";
    grow();
    log.querySelector(":scope > .hint")?.remove();
    const pending = el("div.msg.chat.mine.pending", { "data-text": text }, el("div.msg-meta", {}, icon("user", 11), el("span.party", {}, "you"), el("span.dim", {}, "sending…")), el("div.msg-body", {}, markdown(text)));
    log.append(pending);
    scroll();
    const result = await messageAgent(selected, text);
    if (result.error) {
      note.textContent = result.error;
      pending.classList.add("failed");
    } else if (result.queued) note.textContent = "queued — sent when the daemon answers";
    else {
      note.textContent = "";
      pending.querySelector(".msg-meta .dim")!.textContent = "sent";
      // An agent's chat answers with the logged row itself; pai's with its session.
      const row = result.data as LogMessage | undefined;
      if (row && typeof row.id === "number" && row.kind && concerns(row, selected)) append(row);
    }
  }

  input.addEventListener("input", grow);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void submit();
    }
  });

  // ---- asks and tasks ---------------------------------------------------------------------

  /** The buttons an ask offers, and a line for an answer in words when it takes one (or offers nothing). */
  function answerControls(ask: Ask) {
    const message = el("span.note");
    const answer = async (text: string) => {
      if (!text.trim()) return;
      const result = await answerAsk(ask.id, text.trim());
      if (result.error) message.textContent = result.error;
      else if (result.queued) message.textContent = "queued";
      else answered(ask.id);
    };
    const field = el("input", { type: "text", placeholder: ask.options.length ? "or answer in words…" : "your answer…" }) as HTMLInputElement;
    field.addEventListener("keydown", (event) => event.key === "Enter" && void answer(field.value));
    return el(
      "div.ask-controls",
      {},
      ask.options.length ? el("div.q-options", {}, ...ask.options.map((option) => el("button.btn", { onclick: () => void answer(option) }, option))) : undefined,
      ask.freeText || !ask.options.length ? el("div.row-inline.ask-free", {}, field, el("button.iconbtn", { title: "answer", onclick: () => void answer(field.value) }, icon("send", 12))) : undefined,
      message,
    );
  }

  /** An ask's cards in the log, drawn again: with buttons while it is open, marked once it is not. */
  function redrawAsk(id: number) {
    for (const group of groups) {
      const m = group.rows[0]!;
      if (m.kind !== "ask" || m.meta.askId !== id) continue;
      const fresh = renderGroup(group);
      group.node.replaceWith(fresh);
      group.node = fresh;
    }
  }

  /** An ask is settled: out of the list, its cards in the log marked. */
  function answered(id: number) {
    asks = asks.filter((a) => a.id !== id);
    redrawAsk(id);
    drawTree();
    drawSide();
  }

  const sideTabs = el("div.segmented.staff-tabs");
  const sideBody = el("div.staff-side-body");
  clear(sidePane, el("header.panel-head", {}, sideTabs), sideBody);

  function drawSide() {
    const tab = state.staffTab ?? (asks.length ? "asks" : "tasks");
    const tabButton = (id: "asks" | "tasks", label: string, count: number, name: IconName) =>
      el(
        "button.seg",
        {
          class: `seg${tab === id ? " on" : ""}`,
          onclick: () => {
            state.staffTab = id;
            save();
            drawSide();
          },
        },
        icon(name, 12),
        el("span", {}, label),
        count ? el("span.badge", { class: `badge${id === "asks" ? " ask" : ""}` }, String(count)) : undefined,
      );
    clear(sideTabs, tabButton("asks", "Asks", asks.length, "help"), tabButton("tasks", "Tasks", tasks?.length ?? 0, "list"));
    const scrolled = sideBody.scrollTop;
    if (tab === "asks") drawAsks();
    else drawTasks();
    sideBody.scrollTop = scrolled;
  }

  function drawAsks() {
    const card = (ask: Ask) =>
      el(
        "div.ask-card",
        { class: `ask-card${ask.blocking ? " blocking" : ""}` },
        el(
          "div.msg-meta",
          {},
          party(ask.agent),
          ask.priority !== "normal" ? el("span.tag", { class: `tag prio-${ask.priority}` }, ask.priority) : undefined,
          ask.blocking ? el("span.tag", { title: "the agent waits for this" }, "blocking") : undefined,
          el("span.grow"),
          time(ask.createdAt),
        ),
        ask.context ? el("p.dim.ask-context", {}, ask.context) : undefined,
        el("div.msg-body", {}, markdown(ask.question)),
        answerControls(ask),
      );
    clear(sideBody, ...(asks.length ? asks.map(card) : [el("div.empty", {}, icon("check", 22), el("p.dim", {}, "Nothing waits on you."))]));
  }

  function drawTasks() {
    const grouping = state.taskGrouping === "status" ? "status" : "owner";
    const agent = bySlug(selected);
    const list = (tasks ?? []).filter((t) => !onlySelected || t.owner === selected);
    const titleInput = el("input", { type: "text", placeholder: `New task for ${agent?.name ?? "pai"}…` }) as HTMLInputElement;
    const created = el("span.note");
    titleInput.addEventListener("keydown", async (event) => {
      if (event.key !== "Enter" || !titleInput.value.trim()) return;
      const result = await createTask({ title: titleInput.value.trim(), owner: selected });
      created.textContent = result.error ?? (result.queued ? "queued" : "");
      if (!result.error) titleInput.value = "";
    });
    const seg = (id: "owner" | "status", label: string) =>
      el(
        "button.seg",
        {
          class: `seg${grouping === id ? " on" : ""}`,
          onclick: () => {
            state.taskGrouping = id;
            save();
            drawSide();
          },
        },
        label,
      );
    // The board is a view of its own now (`/ui/board/<agent>`); this control only leads there.
    const toolbar = el(
      "div.task-toolbar",
      {},
      el("div.segmented", {}, seg("owner", "by owner"), seg("status", "by status"), el("button.seg", { title: "the board, in the main view", onclick: () => navigate(selected === PAI ? "board" : { name: "board", param: selected }) }, "board")),
      el("span.grow"),
      el(
        "button.seg",
        {
          class: `seg${onlySelected ? " on" : ""}`,
          title: "only the selected agent's tasks",
          onclick: () => {
            onlySelected = !onlySelected;
            drawSide();
          },
        },
        agent?.name ?? selected,
      ),
    );

    const row = (task: TaskItem) => {
      const set = async (status: TaskStatus) => {
        const result = await updateTask(task.id, { status });
        if (!result.error && !result.queued) upsertTask({ ...task, status });
      };
      return el(
        "div.task-row",
        { class: `task-row status-${task.status}` },
        el(
          "div.task-text",
          {},
          el("span.task-title", { title: task.title }, task.title),
          el(
            "span.dim.task-sub",
            {},
            grouping === "status" ? party(task.owner) : el("span", {}, TASK_STATUS[task.status] ?? task.status),
            task.due ? el("span.tag", { class: `tag${task.due <= new Date().toISOString().slice(0, 10) ? " due" : ""}`, title: "due" }, task.due) : undefined,
            task.nextAction ? el("span.ellipsis", { title: task.nextAction }, task.nextAction) : undefined,
          ),
        ),
        task.source && /^https?:/.test(task.source) ? el("a.iconbtn.slim", { href: task.source, target: "_blank", rel: "noreferrer", title: task.source }, icon("external", 12)) : undefined,
        el("button.iconbtn.slim", { title: "done", onclick: () => void set("done") }, icon("check", 12)),
        el("button.iconbtn.slim", { title: "drop", onclick: () => void set("dropped") }, icon("x", 12)),
      );
    };

    const sections = new Map<string, TaskItem[]>();
    const keyOf = (t: TaskItem) => (grouping === "owner" ? t.owner : t.status);
    // Owners in tree order with the selected one first; statuses in the order they need attention.
    const order = grouping === "owner" ? [selected, ...ordered().map((o) => o.agent.slug)] : Object.keys(TASK_STATUS);
    for (const key of order) sections.set(key, []);
    for (const task of list) sections.set(keyOf(task), [...(sections.get(keyOf(task)) ?? []), task]);
    const blocks = [...sections].filter(([, items]) => items.length).map(([key, items]) =>
      el(
        "section.task-group",
        {},
        el("h3.section-title", {}, grouping === "owner" ? party(key) : (TASK_STATUS[key as TaskStatus] ?? key), el("span.dim", {}, String(items.length))),
        ...items.map(row),
      ),
    );
    clear(
      sideBody,
      el("div.task-new", {}, icon("plus", 12), titleInput, created),
      toolbar,
      ...(tasks === undefined ? [el("p.hint", {}, "This daemon keeps no task list yet.")] : blocks.length ? blocks : [el("p.hint", {}, "No open tasks.")]),
    );
  }

  function upsertTask(task: TaskItem) {
    if (!tasks) return;
    const open = task.status !== "done" && task.status !== "dropped";
    const index = tasks.findIndex((t) => t.id === task.id);
    if (index >= 0) {
      if (open) tasks[index] = { ...tasks[index]!, ...task };
      else tasks.splice(index, 1);
    } else if (open) tasks.push(task);
    drawTree();
    drawSide();
  }

  // ---- loading and following --------------------------------------------------------------

  async function loadAll() {
    try {
      agents = await listAgents();
    } catch (err) {
      clear(root, el("div.notice", {}, el("p", {}, "No staff to show."), el("p.dim", {}, `${(err as Error).message} — a daemon from before pai's agents has no /agents.`)));
      return;
    }
    [asks, tasks, routines] = await Promise.all([listAsks().catch(() => []), taskItems().catch(() => undefined), listRoutines().catch(() => [])]);
    if (!bySlug(selected)) selected = bySlug(PAI) ? PAI : (agents[0]?.slug ?? PAI);
    drawTree();
    drawSide();
    await openChat();
  }

  const stop = follow(
    undefined,
    (event) => {
      const payload = event.payload;
      switch (event.kind) {
        case "message.new": {
          const m = payload as unknown as LogMessage;
          if (concerns(m, selected)) append(m);
          break;
        }
        case "agent.changed": {
          const changed = payload as unknown as Agent;
          const index = agents.findIndex((a) => a.slug === changed.slug);
          if (index < 0) return void listAgents().then((all) => ((agents = all), drawTree()));
          agents[index] = { ...agents[index]!, ...changed };
          drawTree();
          if (changed.slug === selected || lineage(selected).some((a) => a.slug === changed.slug)) drawHead();
          break;
        }
        case "task.added":
        case "task.updated":
          upsertTask(payload as unknown as TaskItem);
          break;
        case "ask.created": {
          const ask = payload as unknown as Ask;
          if (!asks.some((a) => a.id === ask.id)) asks.push(ask);
          redrawAsk(ask.id);
          drawTree();
          drawSide();
          break;
        }
        case "ask.answered":
          answered(Number(payload.id));
          break;
      }
    },
    { replay: false },
  );

  void loadAll();
  return stop;
}
