import { answerAsk, answerQuestion, asks as listAsks, dropAsk, follow, messages as listMessages, messageHeadline, needs as listNeeds, attachmentUrl, toolCall, transcript, type Transcript, type TranscriptTool } from "./api.ts";
import { compose, type Compose, type Prefs } from "./compose.ts";
import { clear, el } from "./dom.ts";
import { icon, type IconName } from "./icons.ts";
import { EVENT_ICONS } from "../../../src/protocol/rich.ts";
import { kindIcon, kindTint } from "./kinds.ts";
import { inline, markdown } from "./markdown.ts";
import type { Agent, AgentStatus, LogMessage, Need, Question } from "./types.ts";

/**
 * A conversation read from the message log: what the user said, what pai (or an agent) said
 * back, the work it handed down and what came back up, its questions, and the events that
 * happened around it — one row per entry, each drawn by its kind. The transcript of the live
 * session adds only the thinking and the tool calls, folded into one line per turn, and the
 * reply that is still being written.
 */

const PAGE = 100;
/** How far back `reveal` pages for a row that is not loaded yet. */
const PAI = "pai";
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
  /** A task's thread inside the agent's: only the rows about that task. */
  readonly task?: number;
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
  /** A plain thread instead of a log: its rows are its own transcript, its live session is itself. */
  readonly session?: string;
  /** What a plain thread was started with, shown until its transcript has it. */
  readonly seed?: string;
  /** While it returns something, what is written goes there instead of into this chat (a new thread from pai's box). */
  readonly divert?: () => ((text: string, images: { media_type: string; data: string }[]) => Promise<void>) | undefined;
  /** A control for the box's foot (see `compose`). */
  readonly boxExtra?: HTMLElement;
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
  /** Scrolls to a row and flashes it, paging back through the log until it is there; false when this chat does not hold it. */
  readonly reveal: (target: RevealTarget) => Promise<boolean>;
  readonly focus: () => void;
  /** The agents changed: the dots on the delegation cards follow. */
  readonly refreshAgents: () => void;
  /** Where the host puts what sits above the box: the hand with what waits. */
  readonly slot: HTMLElement;
  /** The title over the column and, under it, a line of tags. */
  readonly setHead: (title: string | HTMLElement, sub?: HTMLElement) => void;
  readonly refreshPrefs: () => void;
  /** The box, for a host that changes what it says. */
  readonly box: Compose;
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
  /** The session whose transcript holds these calls in full. */
  session?: string;
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
const duration = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.round(ms / 60_000)} min`);
const clock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
const time = (at: number) => el("time", { title: new Date(at).toLocaleString() }, clock(at));
const chevron = () => icon("chevron", 9);

/**
 * A reply quotes what it answers inline, in the text itself: there is nowhere else to put it that
 * survives a reload (a plain SDK thread's history is only ever the text it was sent). `at` is the
 * target's `createdAt`, the one id every row already carries in `data-at`, so the quote can find it.
 */
const REPLY_RE = /^↪ (.+?) @ (\d+): "([^"]*)"\n([\s\S]*)$/;
interface ReplyQuote {
  readonly from: string;
  readonly at: number;
  readonly excerpt: string;
}
function parseReply(body: string): (ReplyQuote & { text: string }) | undefined {
  const m = REPLY_RE.exec(body);
  if (!m) return undefined;
  return { from: m[1]!, at: Number(m[2]), excerpt: m[3]!, text: m[4]! };
}
const withReply = (quote: ReplyQuote | undefined, text: string) => (quote ? `↪ ${quote.from} @ ${quote.at}: "${quote.excerpt.replace(/"/g, "'")}"\n${text}` : text);
const excerptOf = (text: string) => firstLine(parseReply(text)?.text ?? text).replace(/\s+/g, " ").slice(0, 140);
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

/** Built-in tools as the chat says them: a verb and an icon. */
const TOOL_VERBS: Record<string, [string, IconName]> = {
  Bash: ["Ran", "terminal"],
  Read: ["Read", "file"],
  Edit: ["Edited", "pencil"],
  MultiEdit: ["Edited", "pencil"],
  Write: ["Created", "file"],
  NotebookEdit: ["Edited", "pencil"],
  Grep: ["Searched", "search"],
  Glob: ["Found files", "search"],
  WebSearch: ["Searched the web", "globe"],
  WebFetch: ["Fetched", "globe"],
  Agent: ["Delegated", "bot"],
  Task: ["Delegated", "bot"],
  ToolSearch: ["Loaded tools", "wrench"],
  TodoWrite: ["Updated the plan", "list"],
  Skill: ["Used a skill", "book"],
  AskUserQuestion: ["Asked you", "help"],
};
const SERVER_ICONS: Record<string, IconName> = { gmail: "mail", mail: "mail", calendar: "calendar", balance: "calendar", playwright: "globe", browser: "globe", tg: "message", telegram: "message", linkedin: "users", pai: "zap" };
const sentence = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** `mcp__claude_ai_Gmail__gmail_search` → server "Gmail", action "Search"; a built-in → its verb. */
function toolLabel(name: string): { server?: string; action: string; icon: IconName } {
  const builtin = TOOL_VERBS[name];
  if (builtin) return { action: builtin[0], icon: builtin[1] };
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (!mcp) return { action: sentence(name.replace(/_/g, " ")), icon: "wrench" };
  const server = mcp[1]!.replace(/^claude_ai_/, "").replace(/^plugin_[^_]+_/, "").replace(/_/g, " ");
  const key = server.toLowerCase();
  const action = mcp[2]!.replace(new RegExp(`^${key.replace(/\W/g, "_")}_`, "i"), "").replace(/[_-]+/g, " ");
  return { server: sentence(server), action: sentence(action), icon: SERVER_ICONS[key] ?? "zap" };
}

/** What the call was about, without the tool's name the summary starts with. */
function toolArgument(tool: TranscriptTool) {
  const short = tool.name.replace(/^mcp__/, "").replace(/__/g, ":");
  let text = (tool.input ?? "").trim();
  for (const prefix of [short, tool.name]) if (text.startsWith(prefix)) text = text.slice(prefix.length).trim();
  if (tool.name === "ToolSearch") text = text.replace(/^select:/, "").replace(/mcp__[^_]+(?:_[^_]+)*?__/g, "").replace(/,/g, ", ");
  return text.replace(/^(\$|search|fetch|agent:)\s+/, "").replace(/^"(.*)"$/, "$1");
}

/** The pictures a message came with, each opening full size in a new tab. */
function pictures(urls: readonly string[] | undefined) {
  if (!urls?.length) return undefined;
  return el("div.row-images", {}, ...urls.map((src) => el("a", { href: src, target: "_blank", rel: "noopener" }, el("img", { src, alt: "attached image", loading: "lazy" }))));
}

/** A preview the daemon cut ends in "… +N lines". */
const CUT = /\n… \+(\d+) lines$/;

/** "12 lines", "no output" — how much came back, for the end of the row. */
function resultSize(result: string) {
  const text = result.trim();
  if (!text || text === "[]" || text === "{}") return "no output";
  const hidden = Number(CUT.exec(text)?.[1] ?? 0);
  const lines = text.replace(CUT, "").split("\n").length + hidden;
  return lines > 1 ? `${lines} lines` : "";
}

/** A call's input as a person reads it: the command, the path, else the fields. */
function inputText(name: string, input: unknown) {
  if (!input || typeof input !== "object") return String(input ?? "");
  const fields = input as Record<string, unknown>;
  if (name === "Bash" && typeof fields.command === "string") return fields.command;
  const values = Object.values(fields);
  if (values.length === 1 && typeof values[0] === "string") return values[0];
  return JSON.stringify(fields, null, 2);
}

/** One call in a turn: icon, what was done, what on, how much came back; opened, its input and output in full. */
function toolRow(tool: TranscriptTool, session?: string) {
  const { server, action, icon: name } = toolLabel(tool.name);
  const argument = toolArgument(tool);
  const done = tool.result !== undefined;
  const preview = (tool.result ?? "").trim();
  const full = done && tool.id && session ? { session, id: tool.id } : undefined;
  const row = el("div.tool-call", { class: `tool-call${done ? "" : " live"}` });
  const input = el("pre.tool-call-in");
  const output = el("pre.tool-call-out", {}, preview.replace(CUT, "\n…") || "no output");
  let fetched = false;
  const open = async () => {
    head.setAttribute("aria-expanded", String(row.classList.toggle("open")));
    if (!full || fetched || !row.classList.contains("open")) return;
    fetched = true;
    row.classList.add("loading");
    const call = await toolCall(full.session, full.id).catch(() => undefined);
    row.classList.remove("loading");
    if (!call) return;
    const text = inputText(call.name, call.input).trim();
    if (text && text !== argument) clear(input, text);
    if (call.result !== undefined) clear(output, call.result.trim() || "no output");
  };
  const head = el(
    "button.tool-call-head",
    { onclick: () => void open(), "aria-expanded": "false" },
    icon(name, 12),
    el("span.tool-call-what", {}, server ? el("span.tool-call-server", {}, `${server} · `) : undefined, action),
    argument ? el("span.tool-call-arg", {}, argument) : undefined,
    el("span.tool-call-size", {}, done ? resultSize(preview) : "running"),
  );
  row.append(head, input, output);
  if (!done || (!preview && !full)) head.setAttribute("disabled", "");
  return row;
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
  /** Messages whose headline was asked of the daemon once already. */
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
  /** What the next message replies to, while its quote is pinned to the box. */
  let replyTarget: ReplyQuote | undefined;

  const bySlug = (slug: string) => ctx.agents().find((a) => a.slug === slug);
  const nameOf = (party: string) => (party === "user" ? "you" : party === PAI ? "Orchestrator" : (bySlug(party)?.name ?? party.replace(/^(watcher|routine):/, "")));
  const mine = (m: LogMessage) => m.from === options.parent || (options.parent !== "user" && m.from === "user");

  /** Pins a quote of `m` to the box; the next message carries it, Telegram-style. */
  function startReply(m: LogMessage, bodyText: string) {
    pinnedAnswer = undefined;
    const quote: ReplyQuote = { from: nameOf(m.from), at: m.createdAt, excerpt: excerptOf(bodyText) };
    replyTarget = quote;
    box.pin(el("span.ellipsis.quote-pin", {}, icon("reply", 10), " ", el("b", {}, quote.from), ": ", quote.excerpt), () => (replyTarget = undefined));
  }
  /** The reply a message itself carries, as a small clickable bar: author, excerpt, jumps to what it answers. */
  function quoteBlock(quote: ReplyQuote) {
    return el(
      "button.quote-ref",
      {
        type: "button",
        onclick: () => {
          const target = log.querySelector<HTMLElement>(`[data-at="${quote.at}"]`);
          if (target) flash(target);
        },
      },
      icon("reply", 10),
      el("b", {}, quote.from),
      el("span.ellipsis", {}, quote.excerpt),
    );
  }
  /** A small icon on hover, over the top corner of a row, that starts a reply to it. */
  function replyButton(m: LogMessage, bodyText: string) {
    return el("button.row-reply-btn", { type: "button", title: "reply", onclick: () => startReply(m, bodyText) }, icon("reply", 13));
  }

  // ---- the box ---------------------------------------------------------------------------

  const box: Compose = compose({
    placeholder: options.placeholder,
    projectPath: options.projectPath,
    session: () => liveSession,
    prefs: options.prefs,
    setPrefs: options.setPrefs,
    extra: options.boxExtra,
    submit: async (text, images) => {
      if (pinnedAnswer && text) {
        const answer = pinnedAnswer;
        box.pin(undefined);
        pinnedAnswer = undefined;
        return answer(text);
      }
      const diverted = options.divert?.();
      if (diverted) return diverted(text, images);
      const quote = replyTarget;
      replyTarget = undefined;
      box.pin(undefined);
      const wrapped = withReply(quote, text);
      log.querySelector(":scope > .hint")?.remove();
      const local = images.map((image) => `data:${image.media_type};base64,${image.data}`);
      const pending = el(
        "div.row.mine.pending",
        { "data-text": wrapped },
        quote ? quoteBlock(quote) : undefined,
        pictures(local),
        text ? el("div.bubble", {}, markdown(text)) : undefined,
        el("div.row-foot", {}, el("span.grow"), el("span", {}, "sending…")),
      );
      log.append(pending);
      scroll();
      const result = await options.send(wrapped, images);
      if (result.error) {
        box.note.textContent = result.error;
        pending.classList.add("failed");
      } else if (result.queued) box.note.textContent = "queued — sent when the daemon answers";
      else if (options.session) {
        box.note.textContent = "";
        pending.remove();
        place(spoken("user", wrapped, Date.now(), local));
      } else {
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

  /** A reply: the text in full; the time rides the end of the last line when it fits, else the next line, right-aligned. */
  function replyRow(m: LogMessage) {
    const quoted = parseReply(m.body);
    const bodyText = quoted?.text ?? m.body;
    const bubble = el("div.bubble", {}, markdown(bodyText));
    const last = bubble.lastElementChild;
    const stamp = time(m.createdAt);
    stamp.classList.add("inline-time");
    if (last?.classList.contains("md-p")) last.append(stamp);
    else bubble.append(el("p.md-p.only-time", {}, stamp));
    return el("div.row.reply", { "data-message": m.id, "data-at": m.createdAt }, quoted ? quoteBlock(quoted) : undefined, bubble, replyButton(m, bodyText));
  }

  /**
   * The user's message: the tinted bubble on the right, folded to three lines when long. In an agent's chat
   * its parent's words (a delegation) are the same bubble, with who sent it in small bold over the text.
   */
  function mineRow(m: LogMessage) {
    const from = m.from === "user" ? undefined : nameOf(m.from);
    const quoted = parseReply(m.body);
    const bodyText = quoted?.text ?? m.body;
    const long = bodyText.length > MINE_FOLD_CHARS || bodyText.split("\n").length > 3;
    const row = el(
      "div.row.mine",
      { class: `row mine${long ? " folded" : ""}`, "data-message": m.id, "data-task": m.taskId ?? "", "data-at": m.createdAt },
      from ? el("div.row-from", {}, el("b", {}, from), m.taskId ? el("span.tag", {}, `#${m.taskId}`) : undefined) : undefined,
      quoted ? quoteBlock(quoted) : undefined,
      pictures(m.meta.images),
      bodyText.trim() ? el("div.bubble", {}, markdown(bodyText)) : undefined,
      replyButton(m, bodyText),
    );
    const toggle = long ? el("button.more", { onclick: () => (row.classList.toggle("folded"), (toggle!.textContent = row.classList.contains("folded") ? "Show more" : "Show less")) }, "Show more") : undefined;
    row.append(el("div.row-foot", {}, toggle, el("span.grow"), time(m.createdAt)));
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
        ? el("span.pill-line", {}, el("span", {}, m.kind === "delegate" ? "Delegated to" : "Asked"), icon("rocket", 10), statusDot(agent), el("b", {}, nameOf(agent)), target ? el("b", {}, target) : undefined, m.taskId ? el("span.tag", {}, `#${m.taskId}`) : undefined, chevron())
        : el("span.pill-line", {}, icon("rocket", 10), statusDot(agent), headlineOf(m, `${nameOf(m.from)} ${verb}: ${firstLine(m.body)}`), el("span.when", {}, clock(m.createdAt)), m.taskId ? el("span.tag", {}, `#${m.taskId}`) : undefined, chevron()),
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
      // A task that is done somewhere else (a reconnect page) leads with that place, as a button.
      const action = m.body.match(/\[([^\]]+)\]\(((?:https?:\/\/|\/)[^)\s]+)\)/);
      if (action) foot.prepend(el("a.opt", { href: action[2], target: "_blank", rel: "noopener" }, action[1]));
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
              replyTarget = undefined;
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
      el("span.pill-line", {}, eventIcon(m), headlineOf(m), el("span.when", {}, clock(m.createdAt)), chevron()),
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

  function renderMessage(m: LogMessage): HTMLElement {
    switch (m.kind) {
      case "chat":
        return mine(m) ? mineRow(m) : replyRow(m);
      case "delegate":
        // Handed to this agent by its parent: reads as the message it is, not a card about one.
        return mine(m) && m.to === options.agent ? mineRow(m) : card(m);
      case "report":
      case "response":
        // In its own chat what an agent hands back is its reply, drawn as the orchestrator's are.
        return m.from === options.agent ? replyRow(m) : card(m);
      case "request":
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
    const body = el("div.tools-body");
    if (group.open) {
      if (group.thinking) body.append(el("div.tool-thinking", {}, group.thinking));
      for (const tool of group.tools) {
        const line = toolRow(tool, group.session);
        if (tool.id) liveTools.set(tool.id, line);
        body.append(line);
      }
    }
    return el("div.row.tools.tint-muted", { class: `row tools tint-muted${group.live ? " live" : ""}${group.open ? " open" : ""}`, "data-at": group.at }, head, body);
  }

  /** A question the session asked: one block per question, the answered ones ticked, the next one with its buttons. */
  function renderQuestion(q: LiveQuestion): HTMLElement {
    // A fresh question has no answers at all, so the first unanswered one is looked up by question.
    const index = q.questions.findIndex((_, i) => !q.answers[i]);
    const open = index >= 0;
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

  function render(item: Item): HTMLElement {
    if (item.kind === "tools") return renderTools(item);
    if (item.kind === "question") return renderQuestion(item);
    return renderMessage(item.m);
  }

  function redraw(item: Item) {
    const fresh = render(item);
    item.node.replaceWith(fresh);
    item.node = fresh;
  }

  // ---- runs of events: Telegram, Email, Telegram, Email between two replies become "2 Telegram", "2 Email" ----

  const isEvent = (item: Item): item is Row => item.kind === "message" && item.m.kind === "event";
  /** What an event is of: its source when it has one (telegram, gmail), else its event name. */
  const eventType = (m: LogMessage) => ((m.meta as { source?: string }).source ?? m.meta.event ?? "event").toLowerCase();
  const TYPE_LABEL: Record<string, string> = { telegram: "Telegram", gmail: "Email", mail: "Email", linkedin: "LinkedIn", "routine.fired": "routines", "calendar.upcoming": "calendar events", "item.arrived": "items" };
  const typeLabel = (type: string) => TYPE_LABEL[type] ?? type.replace(/^item\./, "");
  /** The icon by where it came from when the source has one (Telegram, LinkedIn), else by the event. */
  const eventIcon = (m: LogMessage) => kindIcon(`item.${eventType(m)}` in EVENT_ICONS ? `item.${eventType(m)}` : (m.meta.event ?? "event"), 10);

  /** One row standing for several events of a type; a click unfolds them. */
  function groupRow(rows: readonly Row[]) {
    const first = rows[0]!.m;
    const last = rows[rows.length - 1]!.m;
    const body = el("div.event-body.group-body");
    const row = el(
      "div.row.pill.event.group.tint-muted",
      { "data-at": first.createdAt },
      el(
        "button.pill-line",
        { onclick: () => row.classList.toggle("open") },
        eventIcon(first),
        el("span.pill-text", {}, `${rows.length} ${typeLabel(eventType(first))}`),
        el("span.when", {}, clock(last.createdAt)),
        chevron(),
      ),
      body,
    );
    for (const r of rows) {
      r.node = render(r);
      body.append(r.node);
    }
    return row;
  }

  /** A run of consecutive events, as nodes: a type that occurs more than once in it is one group row at its first position. */
  function renderRun(run: readonly Row[]): HTMLElement[] {
    const byType = new Map<string, Row[]>();
    for (const r of run) byType.set(eventType(r.m), [...(byType.get(eventType(r.m)) ?? []), r]);
    const nodes: HTMLElement[] = [];
    const done = new Set<string>();
    for (const r of run) {
      const type = eventType(r.m);
      const group = byType.get(type)!;
      if (group.length < 2) {
        r.node = render(r);
        nodes.push(r.node);
      } else if (!done.has(type)) {
        done.add(type);
        nodes.push(groupRow(group));
      }
    }
    return nodes;
  }

  /** Everything, in order, a day separator where the day changes, runs of events compacted. */
  function drawAll() {
    items.sort((a, b) => a.at - b.at);
    const nodes: HTMLElement[] = [];
    let day = "";
    let run: Row[] = [];
    const flush = () => {
      if (run.length) nodes.push(...renderRun(run));
      run = [];
    };
    for (const item of items) {
      if (dayOf(item.at) !== day) {
        flush();
        day = dayOf(item.at);
        nodes.push(el("div.day", {}, el("span", {}, dayLabel(item.at))));
      }
      if (isEvent(item)) {
        run.push(item);
        continue;
      }
      flush();
      item.node = render(item);
      nodes.push(item.node);
    }
    flush();
    const earlier = more ? el("button.btn.chat-more", { onclick: () => void loadEarlier() }, "Load earlier") : undefined;
    clear(log, earlier, ...nodes, ...(items.length ? [] : [el("p.hint", {}, loading ? "…" : "Nothing said here yet.")]));
    if (liveText) log.append(liveText);
    if (working) log.append(working.node);
  }

  /** A row that arrived now goes last, before the streaming reply and the working line. */
  function place(item: Item) {
    items.push(item);
    const stick = nearBottom();
    log.querySelector(":scope > .hint")?.remove();
    const previous = items[items.length - 2];
    const newDay = Boolean(previous && dayOf(previous.at) !== dayOf(item.at));
    if (newDay) log.append(el("div.day", {}, el("span", {}, dayLabel(item.at))));
    const before = liveText?.isConnected ? liveText : (working?.node ?? null);
    if (isEvent(item) && !newDay) {
      // The event joins the run before it: the run is drawn again in place.
      const run: Row[] = [];
      for (let i = items.length - 1; i >= 0 && isEvent(items[i]!) && dayOf(items[i]!.at) === dayOf(item.at); i -= 1) run.unshift(items[i] as Row);
      for (const node of log.querySelectorAll<HTMLElement>(":scope > .row.event, :scope > .row.group")) if (run.some((r) => r.node === node || node.contains(r.node))) node.remove();
      for (const node of renderRun(run)) log.insertBefore(node, before);
    } else {
      item.node = render(item);
      log.insertBefore(item.node, before);
    }
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

  /** A line of a plain thread as a row of the log, so it is drawn as the log's are. */
  let spokenCount = 0;
  const spoken = (from: string, body: string, at: number, images?: readonly string[]): Row => {
    spokenCount += 1;
    const m = { id: -spokenCount, from, to: from === "user" ? options.agent : "user", kind: "chat", body, taskId: null, meta: images?.length ? { images } : {}, createdAt: at } as unknown as LogMessage;
    return { kind: "message", key: `s${spokenCount}`, at, m, node: undefined as unknown as HTMLElement };
  };

  /** A plain thread's transcript as rows: what the user said, each turn's tool calls folded, and the turn's last text as its reply (the texts before it were thinking aloud). */
  function turnsOf(history: Transcript[]): Item[] {
    const out: Item[] = [];
    let group: ToolGroup | undefined;
    let reply: { text: string; at: number } | undefined;
    const ensureGroup = (at: number) =>
      (group ??= (() => {
        const fresh: ToolGroup = { kind: "tools", key: `t${at}`, at, end: at, thinking: "", tools: [], live: false, open: false, session: options.session, node: undefined as unknown as HTMLElement };
        out.push(fresh);
        return fresh;
      })());
    const close = () => {
      if (reply) out.push(spoken(options.agent, reply.text, reply.at));
      reply = undefined;
      group = undefined;
    };
    for (const entry of history) {
      const at = new Date(entry.ts).getTime();
      if (entry.role === "user") {
        if (entry.meta || (!entry.text.trim() && !entry.images?.length) || entry.text.startsWith("[Request interrupted")) continue;
        close();
        out.push(spoken("user", entry.text, at, entry.images?.map(attachmentUrl)));
        continue;
      }
      if (reply && (entry.text.trim() || entry.tools?.length)) {
        const g = ensureGroup(reply.at);
        g.thinking = [g.thinking, reply.text].filter(Boolean).join("\n\n");
        reply = undefined;
      }
      if (entry.thinking || entry.tools?.length) {
        const g = ensureGroup(at);
        g.end = Math.max(g.end, at);
        if (entry.thinking) g.thinking = [g.thinking, entry.thinking].filter(Boolean).join("\n\n");
        g.tools.push(...(entry.tools ?? []));
      }
      if (entry.text.trim()) reply = { text: entry.text, at };
    }
    close();
    return out;
  }

  function groupsOf(history: Transcript[], session: string): ToolGroup[] {
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
        current = { kind: "tools", key: `t${at}`, at, end: at, thinking: "", tools: [], live: false, open: false, session, node: undefined as unknown as HTMLElement };
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
    for (const group of groupsOf(history, session)) if (group.at >= oldest - 60_000 && !items.some((i) => i.key === group.key)) items.push(group);
  }

  // ---- loading and following -------------------------------------------------------------

  async function load() {
    if (options.session) {
      const history = await transcript(options.session, undefined, 300).catch(() => [] as Transcript[]);
      items.push(...turnsOf(history));
      if (options.seed && !items.some((i) => i.kind === "message" && i.m.from === "user")) items.push(spoken("user", options.seed, Date.now()));
      liveSession = options.session;
      items.push(...addQuestions(await listNeeds().catch(() => [] as Need[])));
      loading = false;
      drawAll();
      scroll();
      return;
    }
    const [page, open, needs] = await Promise.all([listMessages(options.agent, { limit: PAGE, task: options.task }), listAsks().catch(() => []), listNeeds().catch(() => [])]);
    for (const a of open) openAsks.add(a.id);
    for (const m of page) {
      seen.add(m.id);
      if (m.kind === "answer" && m.meta.askId !== undefined) answersByAsk.set(m.meta.askId, m.body);
      items.push({ kind: "message", key: `m${m.id}`, at: m.createdAt, m, node: undefined as unknown as HTMLElement });
    }
    more = page.length >= PAGE;
    liveSession = await options.live?.();
    if (liveSession) await loadTools(liveSession);
    if (options.task === undefined) items.push(...addQuestions(needs));
    loading = false;
    drawAll();
    scroll();
  }

  /** Questions a session is waiting on, not yet in the chat: the live one's, and for pai those of its earlier sessions too (a rotation does not answer them); an agent's own. */
  function addQuestions(needs: readonly Need[]) {
    const ours = needs.filter((n) => n.kind === "question" && n.session && (n.session === liveSession || (!options.session && (options.agent === PAI ? n.agent === null : n.agent === options.agent))));
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
    const older = await listMessages(options.agent, { before: first.m.id, limit: PAGE, task: options.task }).catch(() => []);
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

  // pai's chat also holds every question put to the user and every answer, whoever asked.
  const concerns = (m: LogMessage) =>
    options.session
      ? false
      : options.task !== undefined ? m.taskId === options.task : m.from === options.agent || m.to === options.agent || m.meta.agent === options.agent || (options.agent === PAI && (m.kind === "ask" || m.kind === "answer") && (m.to === "user" || m.from === "user"));

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
          if (event.sessionId !== liveSession && options.task === undefined && !options.session)
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
              liveGroup = { kind: "tools", key: `t${event.ts}`, at: event.ts, end: event.ts, thinking: liveText ? liveRaw : "", tools: [], live: true, open: false, session, node: undefined as unknown as HTMLElement };
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
            if (line?.isConnected && tool) {
              const done = toolRow(tool, liveGroup.session);
              line.replaceWith(done);
              liveTools.set(payload.id!, done);
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
            // A plain thread has no log row to take the reply's place: the streamed text is the reply.
            if (options.session && liveText) {
              liveText.dataset.at = String(event.ts);
              liveText = undefined;
              liveRaw = "";
            }
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
  const toBottom = el("button.to-bottom", { title: "to the latest", hidden: true, onclick: () => log.scrollTo({ top: log.scrollHeight, behavior: "smooth" }) }, icon("chevron", 13));
  log.addEventListener("scroll", () => (toBottom.hidden = nearBottom()), { passive: true });
  const node = el("section.chat", {}, el("div.chat-view", {}, head, log, el("div.chat-fade"), el("div.chat-fade.bottom"), el("div.chat-foot", {}, el("div.chat-foot-side", {}, toBottom, slot), box.node)));

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
    async reveal(target) {
      const selector = target.messageId !== undefined ? `[data-message="${target.messageId}"]` : target.askId !== undefined ? `[data-ask="${target.askId}"]` : target.taskId !== undefined ? `[data-task="${target.taskId}"]` : target.question ? ".row.question.open" : "";
      if (!selector) return false;
      const find = () => [...log.querySelectorAll<HTMLElement>(selector)].pop();
      let found = find();
      // As far back as it takes: a need always has its row, however old.
      while (!found && more) {
        await loadEarlier();
        found = find();
      }
      if (!found) return false;
      // A row folded into a group of events opens its group first.
      found.closest(".row.group")?.classList.add("open");
      flash(found);
      return true;
    },
    focus: () => box.focus(),
    refreshAgents,
    refreshPrefs: () => box.refreshPrefs(),
    box,
    slot,
    setHead(text, extra) {
      clear(title, text);
      sub.hidden = !extra;
      clear(sub, extra);
    },
  };
}
