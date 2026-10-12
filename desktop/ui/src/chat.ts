import { answerAsk, answerQuestion, asks as listAsks, dropAsk, follow, messages as listMessages, messageHeadline, messageTldr, needs as listNeeds, transcript, type Transcript, type TranscriptTool } from "./api.ts";
import { compose, type Compose, type Prefs } from "./compose.ts";
import { clear, el } from "./dom.ts";
import { icon } from "./icons.ts";
import { kindIcon, kindTint } from "./kinds.ts";
import { inline, markdown } from "./markdown.ts";
import { resultLine, toolLine } from "./thread.ts";
import type { Agent, AgentStatus, LogMessage, Need, Question } from "./types.ts";

/**
 * A conversation read from the message log: what the user said, what pai (or an agent) said
 * back, the work it handed down and what came back up, its questions, and the events that
 * happened around it — one row per entry, each drawn by its kind. The transcript of the live
 * session adds only the thinking and the tool calls, folded into one line per turn, and the
 * reply that is still being written.
 */

const PAGE = 100;
const PAI = "pai";
/** A reply longer than this is folded unless it is the latest one. */
const FOLD_LINES = 6;
/** A message of the user's longer than this folds to three lines with "Show more". */
const MINE_FOLD_CHARS = 240;

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
  /** What the column is headed with: "General" for pai, the agent's name for a thread. */
  readonly title: string;
  /** The live session, when there is one: its stream and its transcript's tool calls. */
  readonly live?: () => Promise<string | undefined>;
  readonly send: (text: string, images: { media_type: string; data: string }[]) => Promise<{ error?: string; queued?: boolean; data?: unknown }>;
  readonly placeholder: string;
  readonly projectPath?: () => string | undefined;
  /** The model and effort shown in the box's foot, and how to change them. */
  readonly prefs?: () => Prefs | undefined;
  readonly setPrefs?: (changes: Prefs) => Promise<{ error?: string }>;
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
  /** Where the host puts what sits above the box: the hand with what waits. */
  readonly slot: HTMLElement;
  /** The title over the column and, under it, a line of tags. */
  readonly setHead: (title: string, sub?: HTMLElement) => void;
  readonly refreshPrefs: () => void;
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
  return day.toLocaleDateString(undefined, { day: "numeric", month: "long", ...(day.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) });
};
const firstLine = (text: string) => text.replace(/^\[[^\]]+\]\s*/, "").split("\n").find((l) => l.trim()) ?? "";
/** The gist of a long reply: the server's summary, else its first paragraph. */
const summaryOf = (m: LogMessage) => (m.meta.tldr as string | undefined) ?? m.body.replace(/^\[[^\]]+\]\s*/, "").split(/\n\s*\n/).find((p) => p.trim()) ?? m.body;
const duration = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.round(ms / 60_000)} min`);
const clock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const time = (at: number) => el("time", { title: new Date(at).toLocaleString() }, clock(at));
const chevron = () => icon("chevron", 9);
/** "Created a file, ran 5 commands" — what a turn's tool calls amount to, by family. */
function describeTools(tools: readonly TranscriptTool[]) {
  const families: Record<string, [string, string]> = { Write: ["created a file", "created %n files"], Edit: ["edited a file", "edited %n files"], Bash: ["ran a command", "ran %n commands"], Read: ["read a file", "read %n files"], Grep: ["searched", "searched %n times"], Glob: ["searched", "searched %n times"], WebSearch: ["searched the web", "searched the web %n times"], WebFetch: ["fetched a page", "fetched %n pages"], Agent: ["delegated once", "delegated %n times"] };
  const counts = new Map<string, number>();
  for (const t of tools) {
    const family = families[t.name] ? t.name : "other";
    counts.set(family, (counts.get(family) ?? 0) + 1);
  }
  const parts = [...counts].map(([family, n]) => {
    const [one, many] = families[family] ?? ["used a tool", "%n tool calls"];
    return n === 1 ? one : many.replace("%n", String(n));
  });
  const text = parts.join(", ");
  return text ? text[0]!.toUpperCase() + text.slice(1) : "";
}

export function chat(options: ChatOptions, ctx: ChatContext): Chat {
  const log = el("div.chat-log");
  const items: Item[] = [];
  const seen = new Set<number>();
  let more = false;
  let loading = true;
  let liveSession: string | undefined;
  let liveText: HTMLElement | undefined;
  let liveRaw = "";
  let liveGroup: ToolGroup | undefined;
  const liveTools = new Map<string, HTMLElement>();
  const openAsks = new Set<number>();
  const answersByAsk = new Map<number, string>();
  /** The turn in progress: the line that says so, and when it started. */
  let working: { node: HTMLElement; since: number; timer: ReturnType<typeof setInterval> } | undefined;
  /** Messages whose gist or headline was asked of the daemon once already. */
  const askedTldr = new Set<number>();
  const askedHeadline = new Set<number>();
  /** The one line a row shows: the headline when it has one, else the first line while one is written. */
  function headlineOf(m: LogMessage, fallback = firstLine(m.body)) {
    const span = el("span.ellipsis.pill-text", {}, ...inline((m.meta.headline as string | undefined) ?? fallback));
    if (!m.meta.headline && !askedHeadline.has(m.id)) {
      askedHeadline.add(m.id);
      void messageHeadline(m.id)
        .then((r) => {
          if (!r.headline) return;
          (m.meta as { headline?: string }).headline = r.headline;
          if (span.isConnected) span.replaceChildren(...inline(r.headline));
        })
        .catch(() => undefined);
    }
    return span;
  }
  /** What the compose box answers instead of sending a message, while a question is pinned to it. */
  let pinnedAnswer: ((text: string) => Promise<void>) | undefined;

  const bySlug = (slug: string) => ctx.agents().find((a) => a.slug === slug);
  const nameOf = (party: string) => (party === "user" ? "you" : party === PAI ? "Orchestrator" : (bySlug(party)?.name ?? party.replace(/^(watcher|routine):/, "")));
  const mine = (m: LogMessage) => m.from === options.parent || (options.parent !== "user" && m.from === "user");

  // ---- the box ---------------------------------------------------------------------------

  const box: Compose = compose({
    placeholder: options.placeholder,
    projectPath: options.projectPath,
    session: () => liveSession,
    prefs: options.prefs,
    setPrefs: options.setPrefs,
    submit: async (text, images) => {
      if (pinnedAnswer && text) {
        const answer = pinnedAnswer;
        box.pin(undefined);
        pinnedAnswer = undefined;
        return answer(text);
      }
      log.querySelector(":scope > .hint")?.remove();
      const pending = el("div.row.mine.pending", { "data-text": text }, el("div.bubble", {}, markdown(text || "(image)")), el("div.row-foot", {}, el("span.grow"), el("span", {}, "sending…")));
      log.append(pending);
      scroll();
      const result = await options.send(text, images);
      if (result.error) {
        box.note.textContent = result.error;
        pending.classList.add("failed");
      } else if (result.queued) box.note.textContent = "queued — sent when the daemon answers";
      else {
        box.note.textContent = "";
        pending.querySelector(".row-foot span:last-child")!.textContent = "sent";
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
    // Folded: the gist — the server's tl;dr when it has one, else the first paragraph while one is written.
    const gist = long ? el("div.bubble.gist", {}, markdown(summaryOf(m))) : undefined;
    if (gist && folded && !m.meta.tldr && !askedTldr.has(m.id)) {
      askedTldr.add(m.id);
      void messageTldr(m.id)
        .then((r) => {
          if (!r.tldr) return;
          (m.meta as { tldr?: string }).tldr = r.tldr;
          if (gist.isConnected) gist.replaceChildren(markdown(r.tldr));
        })
        .catch(() => undefined);
    }
    const row = el("div.row.reply", { class: `row reply${folded ? " folded" : ""}`, "data-message": m.id, "data-at": m.createdAt }, gist, body);
    const origin = m.meta.origin && m.meta.origin !== "user" ? el("span", { title: "answered a system turn, not you" }, m.meta.origin) : undefined;
    const toggle = long ? el("button.more", { onclick: () => (row.classList.toggle("folded"), (toggle!.textContent = row.classList.contains("folded") ? "Show more" : "Show less")) }, folded ? "Show more" : "Show less") : undefined;
    row.append(el("div.row-foot", {}, toggle, origin, el("span.grow"), time(m.createdAt)));
    return row;
  }

  /** The user's message: the tinted bubble on the right, folded to three lines when long. */
  function mineRow(m: LogMessage) {
    const from = m.from === "user" ? undefined : nameOf(m.from);
    const long = m.body.length > MINE_FOLD_CHARS || m.body.split("\n").length > 3;
    const row = el("div.row.mine", { class: `row mine${long ? " folded" : ""}`, "data-message": m.id, "data-at": m.createdAt }, el("div.bubble", {}, markdown(m.body)));
    const toggle = long ? el("button.more", { onclick: () => (row.classList.toggle("folded"), (toggle!.textContent = row.classList.contains("folded") ? "Show more" : "Show less")) }, "Show more") : undefined;
    row.append(el("div.row-foot", {}, toggle, from ? el("span", {}, from) : undefined, el("span.grow"), time(m.createdAt)));
    return row;
  }

  /** What the agent is at, beside its name: a spinner while it works, a hand while it waits on the user, nothing otherwise. */
  const statusDot = (slug: string) => {
    const status: AgentStatus | "unknown" = bySlug(slug)?.status ?? "unknown";
    const node = el("span.live", { "data-agent": slug });
    if (status === "working") node.append(el("span.spinner", { title: "working now" }));
    else if (status === "waiting") node.append(el("span.attention", { title: "waiting on you" }, icon("hand", 11)));
    else node.hidden = true;
    return node;
  };

  /** `← pai dev reported · Released as v0.6.16` — one line for work handed down or reported back; the body on hover, the thread on click. */
  function card(m: LogMessage) {
    const down = m.kind === "delegate" || m.kind === "request";
    const agent = m.kind === "delegate" ? m.to : m.kind === "report" ? m.from : down ? m.from : m.to;
    const verb = { delegate: "called", report: "completed", request: "asked for", response: "answered" }[m.kind as "delegate" | "report" | "request" | "response"];
    const target = m.to !== options.agent && m.to !== options.parent && m.to !== "user" && m.to !== agent ? nameOf(m.to) : "";
    const openable = Boolean(bySlug(agent)) && agent !== options.agent;
    const row = el(
      "button.row.card.pill",
      {
        class: `row card pill ${m.kind} tint-${kindTint(m.kind)}${mine(m) ? " mine" : ""}`,
        "data-message": m.id,
        "data-task": m.taskId ?? "",
        title: `${m.body.slice(0, 600)}${m.body.length > 600 ? "…" : ""}\n${new Date(m.createdAt).toLocaleString()}${openable ? ` · click opens ${nameOf(agent)}` : ""}`,
        onclick: () => (openable ? ctx.openAgent(agent, m.id) : row.classList.toggle("open")),
      },
      down
        ? el("span.pill-line", {}, el("span", {}, m.kind === "delegate" ? "Delegated to" : "Asked"), kindIcon("agent.spawned", 10), statusDot(agent), el("b", {}, nameOf(agent)), target ? el("b", {}, target) : undefined, m.taskId ? el("span.tag", {}, `#${m.taskId}`) : undefined, chevron())
        : el("span.pill-line", {}, kindIcon("agent.spawned", 10), statusDot(agent), headlineOf(m, `${nameOf(m.from)} ${verb}: ${firstLine(m.body)}`), el("span.when", {}, clock(m.createdAt)), m.taskId ? el("span.tag", {}, `#${m.taskId}`) : undefined, chevron()),
      el("div.card-body", {}, markdown(m.body)),
    );
    row.dataset.at = String(m.createdAt);
    return row;
  }

  /** An agent's ask: yellow and pulsing while open, the answer under it once given. */
  function askRow(m: LogMessage) {
    const askId = m.meta.askId;
    const open = askId !== undefined && openAsks.has(askId);
    const answer = askId !== undefined ? answersByAsk.get(askId) : undefined;
    const who = options.agent === m.from ? "" : ` · ${nameOf(m.from)}`;
    if (!open && askId !== undefined) {
      // Decided: one green line — what was decided — with the question and the answer behind a click.
      const line = el(
        "button.row.pill.decision.tint-ok",
        { "data-message": m.id, "data-ask": askId, "data-task": m.taskId ?? "", "data-at": m.createdAt, onclick: () => line.classList.toggle("open") },
        el("span.pill-line", {}, kindIcon("answered", 10), headlineOf(m, answer ? `${firstLine(m.body)} — ${answer}` : firstLine(m.body)), el("span.when", {}, clock(m.createdAt)), chevron()),
        el("div.event-body", {}, markdown(m.body), answer !== undefined ? el("div.q-answer", {}, icon("check", 10), el("span", {}, answer)) : el("span.dim", {}, "answered")),
      );
      return line;
    }
    const row = el(
      "div.row.question.tint-warn",
      { class: `row question tint-warn${open ? " open" : " answered"}`, "data-message": m.id, "data-ask": askId ?? "", "data-task": m.taskId ?? "", "data-at": m.createdAt },
      el("div.q-meta", {}, kindIcon("approval", 10), el("b", {}, open ? "Action needed" : "Decision made"), el("span", {}, who), m.meta.priority && m.meta.priority !== "normal" ? el("span.tag", { class: `tag prio-${m.meta.priority}` }, m.meta.priority) : undefined),
      m.meta.breadcrumb ? el("div.q-crumb", {}, m.meta.breadcrumb) : undefined,
      el("div.q-body", {}, markdown(m.body)),
    );
    let foot: HTMLElement | undefined;
    if (open && askId !== undefined) {
      const options = m.meta.options ?? [];
      const reply = async (text: string) => {
        const result = await answerAsk(askId, text);
        if (result.error) box.note.textContent = result.error;
        else settleAsk(askId, text);
      };
      const drop = async () => {
        const result = await dropAsk(askId);
        if (result.error) box.note.textContent = result.error;
        else settleAsk(askId);
      };
      foot = answerButtons(options, m.meta.freeText !== false || !options.length, reply, m.body, drop);
    } else if (answer !== undefined) foot = el("div.q-answer", {}, icon("check", 10), el("span", {}, answer));
    else if (askId !== undefined) foot = el("div.q-answer.dim", {}, "answered");
    row.append(el("div.q-foot", {}, foot ?? el("span"), time(m.createdAt)));
    return row;
  }

  /** The pills an answer offers; a bubble for an answer in words, a bin to drop the question. */
  function answerButtons(options: readonly string[], freeText: boolean, reply: (text: string) => Promise<void>, question: string, drop?: () => Promise<void>) {
    const buttons = options.map((option) => el("button.opt", { onclick: () => void reply(option) }, option));
    const typed = freeText
      ? el(
          "button.opt.icon-only",
          {
            title: options.length ? "answer in words" : "answer",
            onclick: () => {
              pinnedAnswer = reply;
              box.pin(el("span.ellipsis", {}, icon("help", 10), " ", firstLine(question)), () => (pinnedAnswer = undefined));
            },
          },
          icon("message", 15),
        )
      : undefined;
    const bin = drop ? el("button.opt.icon-only.faint", { title: "drop this question", onclick: () => void drop() }, icon("trash", 15)) : undefined;
    return el("div.q-options", {}, ...buttons, typed, bin);
  }

  function settleAsk(askId: number, answer?: string) {
    openAsks.delete(askId);
    if (answer !== undefined) answersByAsk.set(askId, answer);
    for (const item of items) if (item.kind === "message" && item.m.kind === "ask" && item.m.meta.askId === askId) redraw(item);
  }

  /** `✉ Google — You shared some data` — one line, truncated; the body as markdown when clicked, the time and the link on hover. */
  function eventRow(m: LogMessage) {
    const name = m.meta.event ?? "event";
    const row = el(
      "button.row.event.pill",
      {
        class: `row event pill tint-${name === "error" ? "hot" : "muted"}`,
        "data-message": m.id,
        "data-task": m.taskId ?? "",
        title: `${firstLine(m.body)}\n${new Date(m.createdAt).toLocaleString()}${m.meta.link ? `\n${m.meta.link}` : ""}`,
        onclick: () => row.classList.toggle("open"),
      },
      el("span.pill-line", {}, kindIcon(name, 10), headlineOf(m), el("span.when", {}, clock(m.createdAt)), chevron()),
      el("div.event-body", {}, markdown(m.body), m.meta.link ? el("a", { href: m.meta.link, target: "_blank", rel: "noreferrer" }, icon("external", 10), " open") : undefined),
    );
    row.dataset.at = String(m.createdAt);
    return row;
  }

  function noticeRow(m: LogMessage) {
    const row = el(
      "button.row.notice.pill.tint-muted",
      { "data-message": m.id, "data-at": m.createdAt, onclick: () => row.classList.toggle("open") },
      el("span.pill-line", {}, kindIcon("notice", 10), headlineOf(m), el("span.when", {}, clock(m.createdAt)), chevron()),
      el("div.event-body", {}, markdown(m.body)),
    );
    return row;
  }

  function answerRow(m: LogMessage) {
    return el(
      "div.row.answer.pill.tint-ok",
      { "data-message": m.id, "data-at": m.createdAt },
      el("span.pill-line", {}, kindIcon("answered", 10), el("span.ellipsis.pill-text", { title: m.body }, `${nameOf(m.from)} answered: ${m.body}`), el("span.when", {}, clock(m.createdAt))),
    );
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
    const what = describeTools(group.tools) || (group.thinking ? "Thought it over" : "Working");
    const span = group.end > group.at ? duration(group.end - group.at) : "";
    const head = el(
      "button.tools-head",
      { onclick: () => ((group.open = !group.open), redraw(group)) },
      group.live ? kindIcon("tools", 10) : undefined,
      el("span", {}, `${what}${span && group.live ? ` · ${span}` : ""}`),
      chevron(),
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
    return el("div.row.tools.tint-muted", { class: `row tools tint-muted${group.live ? " live" : ""}${group.open ? " open" : ""}`, "data-at": group.at }, head, body);
  }

  /** A question the session asked: one block per question, the answered ones ticked, the next one with its buttons. */
  function renderQuestion(q: LiveQuestion): HTMLElement {
    const index = q.answers.findIndex((a) => a === undefined || a === "");
    const open = index >= 0 && index < q.questions.length;
    const row = el("div.row.question.tint-warn", { class: `row question tint-warn${open ? " open" : " answered"}`, "data-question": q.id, "data-at": q.at });
    q.questions.forEach((question, i) => {
      const answered = q.answers[i];
      const block = el("div.q-block", {}, el("div.q-meta", {}, kindIcon("approval", 10), el("b", {}, open ? "Action needed" : "Decision made"), question.header ? el("span", {}, `· ${question.header}`) : undefined), el("div.q-body", {}, markdown(question.question)));
      if (answered) block.append(el("div.q-foot", {}, el("div.q-answer", {}, icon("check", 10), el("span", {}, answered)), i === 0 ? time(q.at) : undefined));
      else if (i === index) {
        const reply = async (text: string) => {
          const result = await answerQuestion(q.session, text);
          if (result.error) box.note.textContent = result.error;
          else {
            q.answers[i] = text;
            redraw(q);
          }
        };
        block.append(el("div.q-foot", {}, answerButtons(question.options.map((o) => o.label), true, reply, question.question), i === 0 ? time(q.at) : undefined));
      } else if (i === 0) block.append(el("div.q-foot", {}, el("span"), time(q.at)));
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
    if (working) log.append(working.node);
  }

  /** A row that arrived now goes last; the reply before it loses its "latest" status and folds. */
  function place(item: Item) {
    items.push(item);
    const stick = nearBottom();
    log.querySelector(":scope > .hint")?.remove();
    const previous = items[items.length - 2];
    if (previous && dayOf(previous.at) !== dayOf(item.at)) log.append(el("div.day", {}, el("span", {}, dayLabel(item.at))));
    item.node = render(item);
    log.insertBefore(item.node, liveText?.isConnected ? liveText : (working?.node ?? null));
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
      liveRaw = "";
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
        current = { kind: "tools", key: `t${at}`, at, end: at, thinking: "", tools: [], live: false, open: false, node: undefined as unknown as HTMLElement };
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
    items.push(...addQuestions(needs));
    loading = false;
    drawAll();
    scroll();
  }

  /** Questions a session is waiting on, not yet in the chat: the live one's, and for pai those of its earlier sessions too (a rotation does not answer them); an agent's own. */
  function addQuestions(needs: readonly Need[]) {
    const ours = needs.filter((n) => n.kind === "question" && n.session && (n.session === liveSession || (options.agent === PAI ? n.agent === null : n.agent === options.agent)));
    const bySession = new Map<string, Need[]>();
    for (const n of ours) bySession.set(n.session!, [...(bySession.get(n.session!) ?? []), n]);
    const added: LiveQuestion[] = [];
    for (const [session, list] of bySession) {
      const id = list[0]!.id.split(":")[2] ?? "";
      if (items.some((i) => i.key === `q${id}`)) continue;
      added.push({ kind: "question", key: `q${id}`, at: list[0]!.createdAt, session, id, questions: list.map((n) => ({ header: "", question: n.question, options: n.options.map((label) => ({ label, description: "" })), multiSelect: false })), answers: [], node: undefined as unknown as HTMLElement });
    }
    return added;
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
        // A question in a session this chat does not stream (an agent's, or one pai asked before a rotation).
        case "session.question":
          if (event.sessionId !== liveSession)
            void listNeeds().then((needs) => {
              const stick = nearBottom();
              for (const q of addQuestions(needs)) place(q);
              if (stick) scroll();
            });
          break;
        case "session.answer":
          if (event.sessionId !== liveSession) {
            const q = items.find((i): i is LiveQuestion => i.kind === "question" && i.session === event.sessionId);
            if (q) {
              q.answers = q.questions.map((_, i) => q.answers[i] ?? "answered");
              redraw(q);
            }
          }
          break;
        // pai's session was rotated: the stream moves to the new one.
        case "main.rotated":
          if (options.live) void options.live().then((session) => session && session !== liveSession && followLive(session));
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
        if (event.kind === "session.delta" || event.kind === "session.tool") startWorking(event.ts);
        switch (event.kind) {
          case "session.delta":
            if (!liveText) {
              liveText = el("div.row.reply.live", {}, el("div.bubble"));
              log.insertBefore(liveText, working?.node ?? null);
            }
            liveRaw = payload.text ?? "";
            liveText.querySelector(".bubble")!.replaceChildren(markdown(liveRaw));
            break;
          case "session.tool": {
            if (!liveGroup) {
              // What streamed before the first call was the model thinking aloud, not the reply.
              liveGroup = { kind: "tools", key: `t${event.ts}`, at: event.ts, end: event.ts, thinking: liveText ? liveRaw : "", tools: [], live: true, open: false, node: undefined as unknown as HTMLElement };
              liveText?.remove();
              liveText = undefined;
              liveRaw = "";
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
            stopWorking();
            break;
          case "session.exit":
            liveGroup = undefined;
            stopWorking();
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
    for (const live of log.querySelectorAll<HTMLElement>(".live[data-agent]")) live.replaceWith(statusDot(live.dataset.agent ?? ""));
  }

  /** "Working on it… 13s" under the last row while a turn runs. */
  function startWorking(since: number) {
    if (working) return;
    const elapsed = el("span.elapsed", {}, duration(Date.now() - since));
    const node = el("div.row.working", {}, el("span.spinner"), el("b", {}, "Working on it…"), elapsed);
    const timer = setInterval(() => (elapsed.textContent = duration(Date.now() - since)), 1000);
    working = { node, since, timer };
    log.append(node);
  }
  function stopWorking() {
    if (!working) return;
    clearInterval(working.timer);
    working.node.remove();
    working = undefined;
  }

  // ---- the head: the title, and the day of the row at the top of the view -------------------

  const title = el("span.chat-title", {}, options.title);
  const sub = el("span.chat-title.sub", { hidden: true });
  const dayPill = el("span.chat-daypill");
  const head = el("div.chat-head", {}, title, sub, dayPill);
  let dayTimer: ReturnType<typeof setTimeout> | undefined;
  const showDay = () => {
    const top = log.getBoundingClientRect().top + 60;
    const first = [...log.querySelectorAll<HTMLElement>("[data-at]")].find((row) => row.getBoundingClientRect().bottom > top);
    if (!first) return (dayPill.classList.remove("shown"), undefined);
    dayPill.textContent = dayLabel(Number(first.dataset.at));
    dayPill.classList.add("shown");
    clearTimeout(dayTimer);
    dayTimer = setTimeout(() => dayPill.classList.remove("shown"), 1500);
  };
  log.addEventListener("scroll", showDay, { passive: true });

  const slot = el("div.chat-slot");
  const node = el("section.chat", {}, el("div.chat-view", {}, head, el("div.chat-fade"), log, el("div.chat-foot", {}, slot, box.node)));

  void load().then(async () => {
    if (liveSession) followLive(liveSession);
  });

  return {
    node,
    dispose: () => {
      stopLog();
      stopLive?.();
      stopWorking();
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
    refreshPrefs: () => box.refreshPrefs(),
    slot,
    setHead(text, extra) {
      title.textContent = text;
      sub.hidden = !extra;
      clear(sub, extra);
    },
  };
}
