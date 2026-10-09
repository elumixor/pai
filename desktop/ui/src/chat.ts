import { answerAsk, answerQuestion, asks as listAsks, follow, messages as listMessages, needs as listNeeds, transcript, type Transcript, type TranscriptTool } from "./api.ts";
import { compose, type Compose } from "./compose.ts";
import { ago, clear, el } from "./dom.ts";
import { icon } from "./icons.ts";
import { kindIcon, kindTint } from "./kinds.ts";
import { markdown } from "./markdown.ts";
import { resultLine, toolLine } from "./thread.ts";
import type { Agent, AgentStatus, LogMessage, Question } from "./types.ts";

/**
 * A conversation read from the message log: what the user said, what pai (or an agent) said
 * back, the work it handed down and what came back up, its questions, and the events that
 * happened around it — one row per entry, each drawn by its kind. The transcript of the live
 * session adds only the thinking and the tool calls, folded into one line per turn, and the
 * reply that is still being written.
 */

const PAGE = 100;
const PAI = "pai";
const TOOLS_OPEN_KEY = "pai.chat.tools";
/** A reply longer than this is folded unless it is the latest one. */
const FOLD_LINES = 6;

export interface ChatContext {
  readonly agents: () => readonly Agent[];
  readonly openAgent: (slug: string, at?: number) => void;
  readonly openBoard: (slug: string) => void;
}

export interface ChatOptions {
  /** Whose log: `pai` for the main chat, an agent's slug for its thread. */
  readonly agent: string;
  /** The side the other party of the log sits on: the user for pai, the parent for an agent. */
  readonly parent: string;
  /** The live session, when there is one: its stream and its transcript's tool calls. */
  readonly live?: () => Promise<string | undefined>;
  readonly send: (text: string, images: { media_type: string; data: string }[]) => Promise<{ error?: string; queued?: boolean; data?: unknown }>;
  readonly placeholder: string;
  readonly projectPath?: () => string | undefined;
}

export interface RevealTarget {
  readonly messageId?: number;
  readonly askId?: number;
  readonly taskId?: number;
  readonly question?: boolean;
}

export interface Chat {
  readonly node: HTMLElement;
  readonly dispose: () => void;
  /** Scrolls to a row and flashes it; false when the row is not in this chat. */
  readonly reveal: (target: RevealTarget) => boolean;
  readonly focus: () => void;
  /** The agents changed: the dots on the delegation cards follow. */
  readonly refreshAgents: () => void;
  /** The switch for whether tool calls open by default, for the host's header. */
  readonly toolsToggle: HTMLElement;
}

/** One turn's thinking and tool calls, from the transcript or the stream. */
interface ToolGroup {
  readonly kind: "tools";
  readonly key: string;
  at: number;
  end: number;
  thinking: string;
  readonly tools: TranscriptTool[];
  live: boolean;
  open: boolean;
  node: HTMLElement;
}

/** A question the live session asked (`AskUserQuestion`), with its answers as they come. */
interface LiveQuestion {
  readonly kind: "question";
  readonly key: string;
  readonly at: number;
  readonly session: string;
  readonly id: string;
  readonly questions: readonly Question[];
  answers: string[];
  node: HTMLElement;
}

interface Row {
  readonly kind: "message";
  readonly key: string;
  readonly at: number;
  readonly m: LogMessage;
  node: HTMLElement;
}

type Item = Row | ToolGroup | LiveQuestion;

const dayOf = (at: number) => new Date(at).toDateString();
const dayLabel = (at: number) => {
  const day = new Date(at);
  const today = new Date();
  if (day.toDateString() === today.toDateString()) return "Today";
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (day.toDateString() === yesterday.toDateString()) return "Yesterday";
  return day.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", ...(day.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) });
};
const firstLine = (text: string) => text.replace(/^\[[^\]]+\]\s*/, "").split("\n").find((l) => l.trim()) ?? "";
const duration = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.round(ms / 60_000)} min`);
const time = (at: number) => el("time", { title: new Date(at).toLocaleString() }, ago(at));

export function chat(options: ChatOptions, ctx: ChatContext): Chat {
  const log = el("div.chat-log");
  const items: Item[] = [];
  const seen = new Set<number>();
  let more = false;
  let loading = true;
  let liveSession: string | undefined;
  let liveText: HTMLElement | undefined;
  let liveGroup: ToolGroup | undefined;
  const liveTools = new Map<string, HTMLElement>();
  const openAsks = new Set<number>();
  const answersByAsk = new Map<number, string>();
  let toolsOpen = localStorage.getItem(TOOLS_OPEN_KEY) === "open";
  /** What the compose box answers instead of sending a message, while a question is pinned to it. */
  let pinnedAnswer: ((text: string) => Promise<void>) | undefined;

  const bySlug = (slug: string) => ctx.agents().find((a) => a.slug === slug);
  const nameOf = (party: string) => (party === "user" ? "you" : (bySlug(party)?.name ?? party.replace(/^(watcher|routine):/, "")));
  const mine = (m: LogMessage) => m.from === options.parent || (options.parent !== "user" && m.from === "user");

  // ---- the box ---------------------------------------------------------------------------

  const box: Compose = compose({
    placeholder: options.placeholder,
    projectPath: options.projectPath,
    session: () => liveSession,
    foot: () => (options.agent === PAI ? "pai" : nameOf(options.agent)),
    submit: async (text, images) => {
      if (pinnedAnswer && text) {
        const answer = pinnedAnswer;
        box.pin(undefined);
        pinnedAnswer = undefined;
        return answer(text);
      }
      log.querySelector(":scope > .hint")?.remove();
      const pending = el("div.row.mine.pending", { "data-text": text }, el("div.bubble", {}, markdown(text || "(image)")), el("div.row-foot", {}, el("span.dim", {}, "sending…")));
      log.append(pending);
      scroll();
      const result = await options.send(text, images);
      if (result.error) {
        box.note.textContent = result.error;
        pending.classList.add("failed");
      } else if (result.queued) box.note.textContent = "queued — sent when the daemon answers";
      else {
        box.note.textContent = "";
        pending.querySelector(".row-foot .dim")!.textContent = "sent";
        const row = result.data as LogMessage | undefined;
        if (row && typeof row.id === "number" && row.kind) append(row);
      }
    },
  });

  const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  const scroll = () => (log.scrollTop = log.scrollHeight);

  // ---- rows ------------------------------------------------------------------------------

  const flash = (node: HTMLElement) => {
    node.scrollIntoView({ block: "center", behavior: "smooth" });
    node.classList.remove("flash");
    void node.offsetWidth;
    node.classList.add("flash");
  };

  /** A reply: left, markdown, folded past a few lines unless it is the latest. */
  function replyRow(m: LogMessage, latest: boolean) {
    const body = el("div.bubble", {}, markdown(m.body));
    const long = m.body.split("\n").length > FOLD_LINES || m.body.length > 700;
    const folded = long && !latest;
    const row = el("div.row.reply", { class: `row reply${folded ? " folded" : ""}`, "data-message": m.id }, body);
    if (long) {
      const toggle = el("button.more", { onclick: () => (row.classList.toggle("folded"), (toggle.textContent = row.classList.contains("folded") ? "more" : "less")) }, folded ? "more" : "less");
      row.append(el("div.row-foot", {}, toggle, el("span.grow"), m.meta.origin && m.meta.origin !== "user" ? el("span.dim", { title: "answered a system turn, not you" }, m.meta.origin) : undefined, time(m.createdAt)));
    } else row.append(el("div.row-foot", {}, m.meta.origin && m.meta.origin !== "user" ? el("span.dim", { title: "answered a system turn, not you" }, m.meta.origin) : undefined, el("span.grow"), time(m.createdAt)));
    return row;
  }

  function mineRow(m: LogMessage) {
    const from = m.from === "user" ? undefined : nameOf(m.from);
    return el("div.row.mine", { "data-message": m.id }, el("div.bubble", {}, markdown(m.body)), el("div.row-foot", {}, from ? el("span.dim", {}, from) : undefined, el("span.grow"), time(m.createdAt)));
  }

  const statusDot = (slug: string) => {
    const status: AgentStatus | "unknown" = bySlug(slug)?.status ?? "unknown";
    const dot = { working: "busy", waiting: "waiting", queued: "queued", idle: "idle", closed: "dead", unknown: "" }[status];
    return el("span", { class: `dot ${dot}`, "data-agent": slug, title: status });
  };

  /** `→ called Screener: look at these three` — a card for work handed down or reported back. */
  function card(m: LogMessage) {
    const other = m.kind === "delegate" || m.kind === "request" ? (mine(m) ? m.to : m.from) : mine(m) ? m.to : m.from;
    const agent = m.kind === "delegate" ? m.to : m.kind === "report" ? m.from : other;
    const verb = { delegate: "called", report: "reported", request: "asked for", response: "answered" }[m.kind as "delegate" | "report" | "request" | "response"];
    const arrow = m.kind === "delegate" || m.kind === "request" ? "→" : "←";
    const openable = Boolean(bySlug(agent)) && agent !== options.agent;
    const row = el(
      "button.row.card",
      {
        class: `row card ${m.kind} tint-${kindTint(m.kind)}${mine(m) ? " mine" : ""}`,
        "data-message": m.id,
        "data-task": m.taskId ?? "",
        title: openable ? `open ${nameOf(agent)}` : m.body,
        onclick: () => (openable ? ctx.openAgent(agent, m.id) : row.classList.toggle("open")),
      },
      el("span.card-head", {}, el("span.arrow", {}, arrow), kindIcon(m.kind, 11), statusDot(agent), el("b", {}, nameOf(agent)), el("span.dim", {}, verb), m.taskId ? el("span.tag", {}, `#${m.taskId}`) : undefined, el("span.grow"), time(m.createdAt)),
      el("span.card-line.ellipsis", {}, firstLine(m.body)),
      el("div.card-body", {}, markdown(m.body)),
    );
    return row;
  }

  /** An agent's ask: yellow and pulsing while open, the answer under it once given. */
  function askRow(m: LogMessage) {
    const askId = m.meta.askId;
    const open = askId !== undefined && openAsks.has(askId);
    const answer = askId !== undefined ? answersByAsk.get(askId) : undefined;
    const row = el(
      "div.row.question.tint-warn",
      { class: `row question tint-warn${open ? " open" : " answered"}`, "data-message": m.id, "data-ask": askId ?? "", "data-task": m.taskId ?? "" },
      el("div.q-meta", {}, kindIcon("ask", 11), el("b", {}, nameOf(m.from)), el("span.dim", {}, "asks"), m.meta.priority && m.meta.priority !== "normal" ? el("span.tag", { class: `tag prio-${m.meta.priority}` }, m.meta.priority) : undefined, el("span.grow"), time(m.createdAt)),
      m.meta.breadcrumb ? el("div.dim.q-crumb", {}, m.meta.breadcrumb) : undefined,
      el("div.q-body", {}, markdown(m.body)),
    );
    if (open && askId !== undefined) {
      const options = m.meta.options ?? [];
      const reply = async (text: string) => {
        const result = await answerAsk(askId, text);
        if (result.error) box.note.textContent = result.error;
        else settleAsk(askId, text);
      };
      row.append(answerButtons(options, m.meta.freeText !== false || !options.length, reply, m.body));
    } else if (answer !== undefined) row.append(el("div.q-answer", {}, icon("check", 11), el("span", {}, answer)));
    else if (askId !== undefined) row.append(el("div.q-answer.dim", {}, "answered"));
    return row;
  }

  /** The buttons an answer offers; one confirm button for a question with a single option; the box for words. */
  function answerButtons(options: readonly string[], freeText: boolean, reply: (text: string) => Promise<void>, question: string) {
    const buttons = options.map((option) => el("button.btn", { onclick: () => void reply(option) }, option));
    const typed = freeText
      ? el(
          "button.btn.ghost",
          {
            onclick: () => {
              pinnedAnswer = reply;
              box.pin(el("span.ellipsis", {}, icon("help", 11), " ", firstLine(question)), () => (pinnedAnswer = undefined));
            },
          },
          options.length ? "answer in words…" : "answer…",
        )
      : undefined;
    return el("div.q-options", {}, ...buttons, typed);
  }

  function settleAsk(askId: number, answer?: string) {
    openAsks.delete(askId);
    if (answer !== undefined) answersByAsk.set(askId, answer);
    for (const item of items) if (item.kind === "message" && item.m.kind === "ask" && item.m.meta.askId === askId) redraw(item);
  }

  /** `⚡ mail arrived: …` — one line, the body as markdown when clicked. */
  function eventRow(m: LogMessage) {
    const name = m.meta.event ?? "event";
    const row = el(
      "button.row.event",
      { class: `row event tint-${name === "error" ? "hot" : "muted"}`, "data-message": m.id, "data-task": m.taskId ?? "", onclick: () => row.classList.toggle("open") },
      el("span.event-line", {}, kindIcon(name, 11), el("span.ellipsis", {}, firstLine(m.body)), m.meta.link ? el("a", { href: m.meta.link, target: "_blank", rel: "noreferrer", title: m.meta.link, onclick: (e: Event) => e.stopPropagation() }, icon("external", 10)) : undefined, time(m.createdAt)),
      el("div.event-body", {}, markdown(m.body)),
    );
    return row;
  }

  function noticeRow(m: LogMessage) {
    const row = el(
      "button.row.notice.tint-muted",
      { "data-message": m.id, onclick: () => row.classList.toggle("open") },
      el("span.event-line", {}, kindIcon("notice", 11), el("span.ellipsis", {}, firstLine(m.body)), time(m.createdAt)),
      el("div.event-body", {}, markdown(m.body)),
    );
    return row;
  }

  function answerRow(m: LogMessage) {
    return el("div.row.answer.tint-ok", { "data-message": m.id }, el("span.event-line", {}, kindIcon("answered", 11), el("span.ellipsis", { title: m.body }, `${nameOf(m.from)} answered: ${m.body}`), time(m.createdAt)));
  }

  function renderMessage(m: LogMessage, latest: boolean): HTMLElement {
    switch (m.kind) {
      case "chat":
        return mine(m) ? mineRow(m) : replyRow(m, latest);
      case "delegate":
      case "report":
      case "request":
      case "response":
        return card(m);
      case "ask":
        return askRow(m);
      case "answer":
        return answerRow(m);
      case "notice":
        return noticeRow(m);
      default:
        return eventRow(m);
    }
  }

  /** `⚙ 7 tool calls · 2 min`, the calls under it when opened. */
  function renderTools(group: ToolGroup): HTMLElement {
    const n = group.tools.length;
    const what = [n ? `${n} tool call${n === 1 ? "" : "s"}` : "", group.thinking && !n ? "thinking" : ""].filter(Boolean).join(" · ") || "working";
    const span = group.end > group.at ? duration(group.end - group.at) : "";
    const head = el(
      "button.tools-head",
      { onclick: () => ((group.open = !group.open), redraw(group)) },
      kindIcon("tools", 11),
      el("span", {}, `${what}${span ? ` · ${span}` : ""}`),
      icon("chevron", 10),
    );
    const body = el("div.tools-body.tui");
    if (group.open) {
      if (group.thinking) body.append(el("div.entry.thinking", {}, el("span.mark", {}, "∴"), el("div.body", {}, group.thinking)));
      for (const tool of group.tools) {
        const line = toolLine(tool);
        if (tool.id) liveTools.set(tool.id, line);
        body.append(line);
      }
    }
    return el("div.row.tools.tint-muted", { class: `row tools tint-muted${group.live ? " live" : ""}${group.open ? " open" : ""}` }, head, body);
  }

  /** A question the session asked: one block per question, the answered ones ticked, the next one with its buttons. */
  function renderQuestion(q: LiveQuestion): HTMLElement {
    const index = q.answers.findIndex((a) => a === undefined || a === "");
    const open = index >= 0 && index < q.questions.length;
    const row = el("div.row.question.tint-warn", { class: `row question tint-warn${open ? " open" : " answered"}`, "data-question": q.id });
    q.questions.forEach((question, i) => {
      const answered = q.answers[i];
      const block = el("div.q-block", {}, el("div.q-meta", {}, kindIcon("question", 11), el("b", {}, question.header || "question"), el("span.grow"), i === 0 ? time(q.at) : undefined), el("div.q-body", {}, markdown(question.question)));
      if (answered) block.append(el("div.q-answer", {}, icon("check", 11), el("span", {}, answered)));
      else if (i === index) {
        const reply = async (text: string) => {
          const result = await answerQuestion(q.session, text);
          if (result.error) box.note.textContent = result.error;
          else {
            q.answers[i] = text;
            redraw(q);
          }
        };
        block.append(answerButtons(question.options.map((o) => o.label), true, reply, question.question));
      }
      row.append(block);
    });
    return row;
  }

  const latestReply = () => {
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i]!;
      if (item.kind === "message" && item.m.kind === "chat" && !mine(item.m)) return item.m.id;
    }
    return undefined;
  };

  function render(item: Item): HTMLElement {
    if (item.kind === "tools") return renderTools(item);
    if (item.kind === "question") return renderQuestion(item);
    return renderMessage(item.m, item.m.id === latestReply());
  }

  function redraw(item: Item) {
    const fresh = render(item);
    item.node.replaceWith(fresh);
    item.node = fresh;
  }

  /** Everything, in order, a day separator where the day changes. */
  function drawAll() {
    items.sort((a, b) => a.at - b.at);
    const nodes: HTMLElement[] = [];
    let day = "";
    for (const item of items) {
      if (dayOf(item.at) !== day) {
        day = dayOf(item.at);
        nodes.push(el("div.day", {}, el("span", {}, dayLabel(item.at))));
      }
      item.node = render(item);
      nodes.push(item.node);
    }
    const earlier = more ? el("button.btn.chat-more", { onclick: () => void loadEarlier() }, "Load earlier") : undefined;
    clear(log, earlier, ...nodes, ...(items.length ? [] : [el("p.hint", {}, loading ? "…" : "Nothing said here yet.")]));
    if (liveText) log.append(liveText);
  }

  /** A row that arrived now goes last; the reply before it loses its "latest" status and folds. */
  function place(item: Item) {
    items.push(item);
    const stick = nearBottom();
    log.querySelector(":scope > .hint")?.remove();
    const previous = items[items.length - 2];
    if (previous && dayOf(previous.at) !== dayOf(item.at)) log.append(el("div.day", {}, el("span", {}, dayLabel(item.at))));
    item.node = render(item);
    if (liveText?.isConnected) log.insertBefore(item.node, liveText);
    else log.append(item.node);
    if (item.kind === "message" && item.m.kind === "chat" && !mine(item.m) && previous?.kind === "message" && previous.m.kind === "chat" && !mine(previous.m)) redraw(previous);
    if (stick) scroll();
  }

  function append(m: LogMessage) {
    if (seen.has(m.id)) return;
    seen.add(m.id);
    if (m.kind === "answer" && m.meta.askId !== undefined) settleAsk(m.meta.askId, m.body);
    if (m.kind === "ask" && m.meta.askId !== undefined) openAsks.add(m.meta.askId);
    if (mine(m) && m.kind === "chat") for (const pending of log.querySelectorAll<HTMLElement>(".row.pending")) if (pending.dataset.text === m.body.trim()) pending.remove();
    // pai's reply row replaces the text that was streaming.
    if (m.kind === "chat" && !mine(m) && liveText) {
      liveText.remove();
      liveText = undefined;
    }
    place({ kind: "message", key: `m${m.id}`, at: m.createdAt, m, node: undefined as unknown as HTMLElement });
  }

  // ---- the transcript: tool calls folded per turn ----------------------------------------

  function groupsOf(history: Transcript[]): ToolGroup[] {
    const groups: ToolGroup[] = [];
    let current: ToolGroup | undefined;
    for (const entry of history) {
      const at = new Date(entry.ts).getTime();
      if (entry.role === "user" && !entry.meta) {
        current = undefined;
        continue;
      }
      if (entry.role !== "assistant" || (!entry.tools?.length && !entry.thinking)) continue;
      if (!current) {
        current = { kind: "tools", key: `t${at}`, at, end: at, thinking: "", tools: [], live: false, open: toolsOpen, node: undefined as unknown as HTMLElement };
        groups.push(current);
      }
      current.end = Math.max(current.end, at);
      if (entry.thinking) current.thinking = [current.thinking, entry.thinking].filter(Boolean).join("\n\n");
      current.tools.push(...(entry.tools ?? []));
    }
    return groups;
  }

  async function loadTools(session: string) {
    const history = await transcript(session, undefined, 300).catch(() => [] as Transcript[]);
    const oldest = items.find((i) => i.kind === "message")?.at ?? 0;
    for (const group of groupsOf(history)) if (group.at >= oldest - 60_000 && !items.some((i) => i.key === group.key)) items.push(group);
  }

  // ---- loading and following -------------------------------------------------------------

  async function load() {
    const [page, open, needs] = await Promise.all([listMessages(options.agent, { limit: PAGE }), listAsks().catch(() => []), listNeeds().catch(() => [])]);
    for (const a of open) openAsks.add(a.id);
    for (const m of page) {
      seen.add(m.id);
      if (m.kind === "answer" && m.meta.askId !== undefined) answersByAsk.set(m.meta.askId, m.body);
      items.push({ kind: "message", key: `m${m.id}`, at: m.createdAt, m, node: undefined as unknown as HTMLElement });
    }
    more = page.length >= PAGE;
    liveSession = await options.live?.();
    if (liveSession) await loadTools(liveSession);
    // Questions a session is waiting on right now, asked before this page opened: the live one's, and for pai
    // those of its earlier sessions too (a rotation does not answer them).
    if (options.live) {
      const pending = needs.filter((n) => n.kind === "question" && n.session && (n.session === liveSession || n.agent === null));
      const bySession = new Map<string, typeof pending>();
      for (const n of pending) bySession.set(n.session!, [...(bySession.get(n.session!) ?? []), n]);
      for (const [session, list] of bySession) {
        const id = list[0]!.id.split(":")[2] ?? "";
        items.push({ kind: "question", key: `q${id}`, at: list[0]!.createdAt, session, id, questions: list.map((n) => ({ header: "", question: n.question, options: n.options.map((label) => ({ label, description: "" })), multiSelect: false })), answers: [], node: undefined as unknown as HTMLElement });
      }
    }
    loading = false;
    drawAll();
    scroll();
  }

  async function loadEarlier() {
    const first = items.find((i): i is Row => i.kind === "message");
    if (!first) return;
    const older = await listMessages(options.agent, { before: first.m.id, limit: PAGE }).catch(() => []);
    const fresh = older.filter((m) => !seen.has(m.id));
    for (const m of fresh) {
      seen.add(m.id);
      items.push({ kind: "message", key: `m${m.id}`, at: m.createdAt, m, node: undefined as unknown as HTMLElement });
    }
    more = older.length >= PAGE;
    const fromBottom = log.scrollHeight - log.scrollTop;
    drawAll();
    log.scrollTop = log.scrollHeight - fromBottom;
  }

  const concerns = (m: LogMessage) => m.from === options.agent || m.to === options.agent || m.meta.agent === options.agent;

  const stopLog = follow(
    undefined,
    (event) => {
      const payload = event.payload;
      switch (event.kind) {
        case "message.new": {
          const m = payload as unknown as LogMessage;
          if (concerns(m)) append(m);
          break;
        }
        case "ask.answered": {
          const a = payload as { id: number; answer?: string };
          settleAsk(Number(a.id), a.answer);
          break;
        }
        case "agent.changed":
          refreshAgents();
          break;
      }
    },
    { replay: false },
  );

  /** The live session's own stream: the reply as it is written, the tool calls as they run, its questions. */
  let stopLive: (() => void) | undefined;
  function followLive(session: string) {
    stopLive?.();
    liveSession = session;
    stopLive = follow(
      session,
      (event) => {
        const payload = event.payload as { text?: string; summary?: string; name?: string; id?: string; parent?: string; result?: string; questions?: Question[]; answers?: Record<string, string> };
        const stick = nearBottom();
        switch (event.kind) {
          case "session.delta":
            if (!liveText) {
              liveText = el("div.row.reply.live", {}, el("div.bubble"));
              log.append(liveText);
            }
            liveText.querySelector(".bubble")!.replaceChildren(markdown(payload.text ?? ""));
            break;
          case "session.tool": {
            if (!liveGroup) {
              liveGroup = { kind: "tools", key: `t${event.ts}`, at: event.ts, end: event.ts, thinking: "", tools: [], live: true, open: toolsOpen, node: undefined as unknown as HTMLElement };
              liveText?.remove();
              liveText = undefined;
              place(liveGroup);
            }
            liveGroup.end = event.ts;
            liveGroup.tools.push({ id: payload.id, name: payload.name ?? "tool", input: payload.summary });
            redraw(liveGroup);
            break;
          }
          case "session.tool_result": {
            if (!liveGroup) break;
            const tool = liveGroup.tools.find((t) => t.id === payload.id);
            if (tool) (tool as { result?: string }).result = payload.result ?? "";
            liveGroup.end = event.ts;
            const line = payload.id ? liveTools.get(payload.id) : undefined;
            if (line?.isConnected) {
              line.classList.remove("live");
              line.append(resultLine(payload.result ?? ""));
            } else redraw(liveGroup);
            break;
          }
          case "session.question": {
            const q: LiveQuestion = { kind: "question", key: `q${payload.id}`, at: event.ts, session, id: payload.id ?? "", questions: payload.questions ?? [], answers: [], node: undefined as unknown as HTMLElement };
            if (!items.some((i) => i.key === q.key)) place(q);
            break;
          }
          case "session.answer": {
            const q = items.find((i): i is LiveQuestion => i.kind === "question" && i.id === payload.id);
            if (q) {
              // The answers come keyed by the question's text, once every question has one.
              q.answers = q.questions.map((question, i) => payload.answers?.[question.question] ?? q.answers[i] ?? "answered");
              redraw(q);
            }
            break;
          }
          case "session.turn_end":
            if (liveGroup) {
              liveGroup.live = false;
              redraw(liveGroup);
              liveGroup = undefined;
            }
            liveText?.classList.remove("live");
            break;
          case "session.exit":
            liveGroup = undefined;
            break;
          default:
            return;
        }
        if (stick) scroll();
      },
      { deltas: true, replay: false },
    );
  }

  function refreshAgents() {
    for (const dot of log.querySelectorAll<HTMLElement>(".dot[data-agent]")) {
      const status = bySlug(dot.dataset.agent ?? "")?.status ?? "unknown";
      dot.className = `dot ${{ working: "busy", waiting: "waiting", queued: "queued", idle: "idle", closed: "dead", unknown: "" }[status]}`;
      dot.title = status;
    }
  }

  const toolsToggle = el(
    "button.iconbtn.slim",
    {
      title: "show the tool calls by default",
      class: `iconbtn slim${toolsOpen ? " on" : ""}`,
      onclick: () => {
        toolsOpen = !toolsOpen;
        localStorage.setItem(TOOLS_OPEN_KEY, toolsOpen ? "open" : "closed");
        toolsToggle.classList.toggle("on", toolsOpen);
        for (const item of items)
          if (item.kind === "tools") {
            item.open = toolsOpen;
            redraw(item);
          }
      },
    },
    icon("gear", 12),
  );

  const node = el("section.chat", {}, log, box.node);

  void load().then(async () => {
    if (liveSession) followLive(liveSession);
  });

  return {
    node,
    dispose: () => {
      stopLog();
      stopLive?.();
    },
    reveal(target) {
      const selector = target.messageId !== undefined ? `[data-message="${target.messageId}"]` : target.askId !== undefined ? `[data-ask="${target.askId}"]` : target.taskId !== undefined ? `[data-task="${target.taskId}"]` : target.question ? ".row.question.open" : "";
      const found = selector ? [...log.querySelectorAll<HTMLElement>(selector)].pop() : undefined;
      if (!found) return false;
      flash(found);
      return true;
    },
    focus: () => box.focus(),
    refreshAgents,
    toolsToggle,
  };
}
