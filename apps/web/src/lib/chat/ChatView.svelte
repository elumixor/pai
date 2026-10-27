<script lang="ts" module>
  import type { Sent } from "../api";
  import type { Upload } from "../types";
  import type { Prefs, Submit } from "./Compose.svelte";

  /** Which conversation a chat shows and how it talks back. */
  export interface ChatSpec {
    /** Which chat this is, for what is remembered about it: the draft, the place, what he has read. */
    readonly key: string;
    /** Whose log: `pai` for the main chat, an agent's slug for its thread, `thread` for a plain thread. */
    readonly agent: string;
    /** A task's thread inside the agent's: only the rows about that task. */
    readonly task?: number;
    /** The side the other party of the log sits on: the user for pai, the parent for an agent. */
    readonly parent: string;
    /** A plain thread instead of a log: its rows are its own transcript, its live session is itself. */
    readonly session?: string;
    /** What a plain thread was started with, shown until its transcript has it. */
    readonly seed?: string;
    /** The live session, when there is one: its stream and its transcript's tool calls. */
    readonly live?: () => Promise<string | undefined>;
    readonly send: (text: string, images: readonly Upload[]) => Promise<Sent>;
    readonly placeholder: string;
    readonly prefs?: () => Prefs | undefined;
    readonly setPrefs?: (changes: Prefs) => Promise<{ error?: string }>;
    /** While it returns something, what is written goes there instead of into this chat (a new thread from pai's box). */
    readonly divert?: () => Submit | undefined;
    /** Why the box takes nothing (a closed agent). */
    readonly disabled?: string;
  }
</script>

<script lang="ts">
  import { tick, type Snippet } from "svelte";
  import { SvelteMap, SvelteSet } from "svelte/reactivity";
  import { api } from "../api";
  import { desk, PAI } from "../desk.svelte";
  import { dayLabel, dayOf, duration } from "../format";
  import { mdTimed } from "../markdown";
  import { flushReads, loadReads, markRead, readAt } from "../reads";
  import { reveal as pendingReveal, type RevealTarget } from "../reveal.svelte";
  import { live as stream } from "../stores/live.svelte";
  import { forget, recallRaw, remember } from "../storage";
  import type { LogMessage, Need, Question, Transcript } from "../types";
  import Icon from "../ui/Icon.svelte";
  import { menus } from "../ui/menu-state.svelte";
  import Compose from "./Compose.svelte";
  import type { RowContext } from "./context";
  import FindBar, { type FindTarget } from "./FindBar.svelte";
  import MessageRow from "./MessageRow.svelte";
  import { describeTools, eventIcon, eventType, excerptOf, type Item, type LiveQuestion, type ReplyQuote, type Row, textOf, type ToolGroup, typeLabel, withReply } from "./model";
  import Pictures from "./Pictures.svelte";
  import QuestionRow from "./QuestionRow.svelte";
  import QuoteRef from "./QuoteRef.svelte";
  import ToolsRow from "./ToolsRow.svelte";

  /**
   * A conversation read from the message log: what he said, what pai (or an agent) said back, the work it handed
   * down and what came back up, its questions, and the events around it — one row per entry, each drawn by its kind.
   * The transcript of the live session adds the thinking and the tool calls, folded into one line per turn, and the
   * reply that is still being written. Days are marked, runs of events compacted, what he has not read is marked
   * until he has seen it.
   */
  let { spec, extra, slot, openAgent }: { spec: ChatSpec; extra?: Snippet; slot?: Snippet; openAgent: (slug: string, at?: number) => void } = $props();

  const PAGE = 100;
  /** What counts as something said to him: a reply or a report with text in it — not an event, a card, an ask. */
  const SAID = ["chat", "report", "response"];
  const DWELL_MS = 500;
  const SWIPE_REPLY = 56;
  const SWIPE_MAX = 84;
  const STAGGER_MS = 28;
  const STAGGER_MAX = 18;

  let items = $state<Item[]>([]);
  const seen = new Set<number>();
  let more = $state(false);
  let loading = $state(true);
  const openAsks = new SvelteSet<number>();
  const answers = new SvelteMap<number, string>();
  const openKeys = new SvelteSet<string>();
  let liveSession = $state<string | undefined>();
  let liveText = $state<string | null>(null);
  let liveGroup: ToolGroup | undefined;
  let working = $state<{ since: number } | null>(null);
  let now = $state(Date.now());
  let pending = $state<{ id: number; text: string; body: string; quote?: ReplyQuote; images: string[]; state: "sending" | "sent" | "failed" }[]>([]);
  let openedAt = $state(0);
  let replyTarget: ReplyQuote | undefined;
  let pinnedAnswer: ((text: string) => Promise<unknown>) | undefined;
  let log = $state<HTMLDivElement>();
  let box = $state<Compose>();
  let find = $state<FindBar>();
  let loader = $state<HTMLDivElement>();
  let scrollbar = $state<HTMLDivElement>();
  let thumb = $state<HTMLDivElement>();
  let day = $state("");
  let dayShown = $state(false);
  let atBottom = $state(true);
  let barMoving = $state(false);
  let barDragging = $state(false);
  let spokenCount = 0;
  let pendingCount = 0;
  /** Rows drawn once already: a redraw lets only the others in, one after another, bottom to top. */
  const drawn = new Set<string>();
  const asked = new Set<number>();

  const readPlace = $derived(`chat:${spec.key}`);
  const placeKey = $derived(`pai.scroll:${spec.key}`);
  const replyKey = $derived(`pai.reply:${spec.key}`);
  const isMine = (m: LogMessage) => m.from === spec.parent || (spec.parent !== "user" && m.from === "user");
  const nameOf = (party: string) => (party === "user" ? "you" : party === PAI ? "Orchestrator" : (desk.bySlug(party)?.name ?? party.replace(/^(watcher|routine):/, "")));
  const said = (item: Item): item is Row => item.kind === "message" && SAID.includes(item.m.kind) && !isMine(item.m) && item.m.from !== "user" && !item.m.meta.place && Boolean(item.m.body.trim());
  const isEvent = (item: Item): item is Row => item.kind === "message" && item.m.kind === "event" && !item.m.meta.draft;
  const messageItem = (m: LogMessage): Row => ({ kind: "message", key: `m${m.id}`, at: m.createdAt, m });

  // ---- what is drawn: days, the "new" line, runs of events folded by type ------------------------------------

  type Entry =
    | { type: "day"; key: string; label: string }
    | { type: "new"; key: string }
    | { type: "item"; key: string; item: Item }
    | { type: "group"; key: string; rows: Row[] };

  const entries = $derived.by(() => {
    const sorted = [...items].sort((a, b) => a.at - b.at);
    const out: Entry[] = [];
    // "New" goes over the oldest row he has not read, once, and only when there is something above it.
    const firstUnread = openedAt ? sorted.find((i) => i.at > openedAt && said(i)) : undefined;
    const divided = firstUnread && sorted.some((i) => i.at <= openedAt);
    let current = "";
    let run: Row[] = [];
    const flush = () => {
      if (!run.length) return;
      const byType = new Map<string, Row[]>();
      for (const r of run) byType.set(eventType(r.m), [...(byType.get(eventType(r.m)) ?? []), r]);
      const done = new Set<string>();
      for (const r of run) {
        const type = eventType(r.m);
        const group = byType.get(type)!;
        if (group.length < 2) out.push({ type: "item", key: r.key, item: r });
        else if (!done.has(type)) {
          done.add(type);
          out.push({ type: "group", key: `g${group[0]!.key}`, rows: group });
        }
      }
      run = [];
    };
    for (const item of sorted) {
      if (dayOf(item.at) !== current) {
        flush();
        current = dayOf(item.at);
        out.push({ type: "day", key: `day:${current}`, label: dayLabel(item.at) });
      }
      if (divided && item === firstUnread) {
        flush();
        out.push({ type: "new", key: "new-line" });
      }
      if (isEvent(item)) {
        run.push(item);
        continue;
      }
      flush();
      out.push({ type: "item", key: item.key, item });
    }
    flush();
    return out;
  });

  /** The delay a row comes in with: the new ones one after another, the lowest first; -1 for one drawn before. */
  const delays = $derived.by(() => {
    const out = new Map<string, number>();
    let step = 0;
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const key = entries[i]!.key;
      if (drawn.has(key) || !drawn.size) continue;
      out.set(key, Math.min(step, STAGGER_MAX) * STAGGER_MS);
      step += 1;
    }
    return out;
  });
  $effect(() => {
    for (const entry of entries) drawn.add(entry.key);
  });

  const animated = new Set<string>();
  /** Lets a row in once, the first time it is drawn, after its delay. */
  function freshen(node: HTMLElement, key: string) {
    const delay = delays.get(key);
    if (delay === undefined || animated.has(key) || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    animated.add(key);
    node.classList.add("fresh");
    if (delay) node.style.animationDelay = `${delay}ms`;
    setTimeout(() => {
      node.classList.remove("fresh");
      node.style.removeProperty("animation-delay");
    }, 370 + delay);
  }

  /** What every row's root element carries: its entrance, and for a row that counts, the watch for being read. Kept per row, so a redraw does not re-attach. */
  const attachments = new Map<string, (node: HTMLElement) => (() => void) | undefined>();
  function rowAttach(key: string, item?: Item) {
    let found = attachments.get(key);
    if (!found) {
      found = (node: HTMLElement) => {
        freshen(node, key);
        return item ? readable(item)(node) : undefined;
      };
      attachments.set(key, found);
    }
    return found;
  }

  // ---- the row context --------------------------------------------------------------------------------------

  const ctx: RowContext = {
    get agent() {
      return spec.agent;
    },
    get parent() {
      return spec.parent;
    },
    nameOf,
    mine: isMine,
    isOpen: (key) => openKeys.has(key),
    toggle: (key) => (openKeys.has(key) ? openKeys.delete(key) : openKeys.add(key)),
    openAsks,
    answers,
    jump: (quote) => {
      const target = log?.querySelector<HTMLElement>(quote.messageId !== undefined ? `[data-message="${quote.messageId}"]` : `[data-at="${quote.at}"]`);
      if (target) flash(target);
    },
    openAgent: (slug, at) => openAgent(slug, at),
    answerAsk: async (askId, text) => {
      const result = await api.answerAsk(askId, text);
      if (result.error) box?.setNote(result.error);
      else settleAsk(askId, text);
    },
    dropAsk: async (askId) => {
      const result = await api.dropAsk(askId);
      if (result.error) box?.setNote(result.error);
      else settleAsk(askId);
    },
    answerQuestion: async (session, text) => {
      const result = await api.answerQuestion(session, text);
      if (result.error) box?.setNote(result.error);
      return !result.error;
    },
    pinAnswer: (question, reply) => {
      dropReply();
      pinnedAnswer = reply;
      box?.setPin({ icon: "help", text: question.split("\n").find((l) => l.trim()) ?? question, onDismiss: () => (pinnedAnswer = undefined) });
    },
    draftsChanged: () => void refreshDrafts(),
  };

  function settleAsk(askId: number, answer?: string) {
    openAsks.delete(askId);
    if (answer !== undefined) answers.set(askId, answer);
    void desk.refreshNeeds();
  }

  // ---- replies: the quote pinned to the box, remembered across a reload ----------------------------------------

  function startReply(m: LogMessage) {
    pinReply({ from: nameOf(m.from), at: m.createdAt, excerpt: excerptOf(textOf(m)), messageId: m.id });
    box?.focus();
  }
  function pinReply(quote: ReplyQuote, keep = true) {
    pinnedAnswer = undefined;
    replyTarget = quote;
    if (keep) remember(replyKey, JSON.stringify(quote));
    box?.setPin({ icon: "reply", from: quote.from, text: quote.excerpt, onDismiss: dropReply });
  }
  function dropReply() {
    replyTarget = undefined;
    forget(replyKey);
  }
  /** What he was replying to when he left, unless that row is gone — then the words stay, the quote does not. */
  function restoreReply() {
    const stored = recallRaw(replyKey);
    if (!stored) return;
    try {
      const quote = JSON.parse(stored) as ReplyQuote;
      if (!quote?.excerpt || !quote.from || (quote.messageId !== undefined && !items.some((i) => i.kind === "message" && i.m.id === quote.messageId))) return forget(replyKey);
      pinReply(quote, false);
    } catch {
      forget(replyKey);
    }
  }

  // ---- sending -------------------------------------------------------------------------------------------------

  async function submit(text: string, images: readonly Upload[]) {
    if (pinnedAnswer && text) {
      const answer = pinnedAnswer;
      pinnedAnswer = undefined;
      box?.setPin(null);
      await answer(text);
      return;
    }
    const diverted = spec.divert?.();
    if (diverted) return diverted(text, images);
    const quote = replyTarget;
    dropReply();
    box?.setPin(null);
    const body = withReply(quote, text);
    const row = { id: ++pendingCount, text, body, quote, images: images.filter((i) => i.media_type.startsWith("image/")).map((i) => `data:${i.media_type};base64,${i.data}`), state: "sending" as const };
    pending = [...pending, row];
    void scrollSoon(true);
    const result = await spec.send(body, images);
    if (result.error) {
      box?.setNote(result.error);
      pending = pending.map((p) => (p.id === row.id ? { ...p, state: "failed" } : p));
      return;
    }
    box?.setNote("");
    if (spec.session) {
      pending = pending.filter((p) => p.id !== row.id);
      place(spoken("user", body, Date.now(), row.images));
      return;
    }
    pending = pending.map((p) => (p.id === row.id ? { ...p, state: "sent" } : p));
    const back = result.data as LogMessage | undefined;
    if (back && typeof back.id === "number" && back.kind) append(back);
  }

  // ---- placing rows --------------------------------------------------------------------------------------------

  const nearBottom = () => !log || log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  const scroll = () => log && (log.scrollTop = log.scrollHeight);
  async function scrollSoon(force = false) {
    const stick = force || nearBottom();
    await tick();
    if (stick) scroll();
    requestAnimationFrame(drawBar);
  }

  function place(item: Item) {
    const stick = nearBottom();
    items.push(item);
    if (stick) void scrollSoon(true);
  }

  function append(m: LogMessage) {
    if (seen.has(m.id)) return;
    seen.add(m.id);
    if (m.kind === "answer" && m.meta.askId !== undefined) settleAsk(m.meta.askId, m.body);
    if (m.kind === "ask" && m.meta.askId !== undefined) openAsks.add(m.meta.askId);
    if (isMine(m) && m.kind === "chat") pending = pending.filter((p) => p.body.trim() !== m.body.trim());
    // pai's reply row replaces the text that was streaming.
    if (m.kind === "chat" && !isMine(m)) liveText = null;
    place(messageItem(m));
    wantHeadline(m);
  }

  /** The one line a pill shows: the daemon writes a headline for a row once, when asked. */
  function wantHeadline(m: LogMessage) {
    if (m.meta.headline || asked.has(m.id) || !["event", "notice", "report", "response", "ask"].includes(m.kind)) return;
    asked.add(m.id);
    void api
      .headline(m.id)
      .then((r) => {
        if (!r.headline) return;
        const item = items.find((i): i is Row => i.kind === "message" && i.m.id === m.id);
        if (item) item.m = { ...item.m, meta: { ...item.m.meta, headline: r.headline } };
      })
      .catch(() => undefined);
  }

  /** A line of a plain thread as a row of the log, so it is drawn as the log's are. */
  function spoken(from: string, body: string, at: number, images?: readonly string[]): Row {
    spokenCount += 1;
    const m = { id: -spokenCount, from, to: from === "user" ? spec.agent : "user", kind: "chat", body, taskId: null, meta: images?.length ? { images } : {}, createdAt: at } as unknown as LogMessage;
    return { kind: "message", key: `s${spokenCount}`, at, m };
  }

  /** A plain thread's transcript as rows: what he said, each turn's tool calls folded, the turn's last text as its reply. */
  function turnsOf(history: Transcript[]): Item[] {
    const out: Item[] = [];
    let group: ToolGroup | undefined;
    let reply: { text: string; at: number } | undefined;
    const ensure = (at: number) => {
      if (!group) {
        group = { kind: "tools", key: `t${at}`, at, end: at, thinking: "", tools: [], live: false, session: spec.session };
        out.push(group);
      }
      return group;
    };
    const close = () => {
      if (reply) out.push(spoken(spec.agent, reply.text, reply.at));
      reply = undefined;
      group = undefined;
    };
    for (const entry of history) {
      const at = new Date(entry.ts).getTime();
      if (entry.role === "user") {
        if (entry.meta || (!entry.text.trim() && !entry.images?.length) || entry.text.startsWith("[Request interrupted")) continue;
        close();
        out.push(spoken("user", entry.text, at, entry.images));
        continue;
      }
      // The texts before a turn's last one were the model thinking aloud.
      if (reply && (entry.text.trim() || entry.tools?.length)) {
        const g = ensure(reply.at);
        g.thinking = [g.thinking, reply.text].filter(Boolean).join("\n\n");
        reply = undefined;
      }
      if (entry.thinking || entry.tools?.length) {
        const g = ensure(at);
        g.end = Math.max(g.end, at);
        if (entry.thinking) g.thinking = [g.thinking, entry.thinking].filter(Boolean).join("\n\n");
        g.tools.push(...(entry.tools ?? []));
      }
      if (entry.text.trim()) reply = { text: entry.text, at };
    }
    close();
    return out;
  }

  /** The live session's tool calls from its transcript, folded per turn, beside the log's rows. */
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
        current = { kind: "tools", key: `t${at}`, at, end: at, thinking: "", tools: [], live: false, session };
        groups.push(current);
      }
      current.end = Math.max(current.end, at);
      if (entry.thinking) current.thinking = [current.thinking, entry.thinking].filter(Boolean).join("\n\n");
      current.tools.push(...(entry.tools ?? []));
    }
    return groups;
  }

  /** Questions a session is waiting on, not yet in the chat: the live one's, and for pai those of earlier sessions too. */
  function questionsFrom(needs: readonly Need[]): LiveQuestion[] {
    const ours = needs.filter((n) => n.kind === "question" && n.session && (n.session === liveSession || (!spec.session && (spec.agent === PAI ? n.agent === null : n.agent === spec.agent))));
    const bySession = new Map<string, Need[]>();
    for (const n of ours) bySession.set(n.session!, [...(bySession.get(n.session!) ?? []), n]);
    const added: LiveQuestion[] = [];
    for (const [session, list] of bySession) {
      const id = list[0]!.id.split(":")[2] ?? "";
      if (items.some((i) => i.key === `q${id}`)) continue;
      added.push({ kind: "question", key: `q${id}`, at: list[0]!.createdAt, session, id, questions: list.map((n) => ({ header: "", question: n.question, options: n.options.map((label) => ({ label, description: "" })), multiSelect: false })), answers: [] });
    }
    return added;
  }

  // ---- loading -------------------------------------------------------------------------------------------------

  async function load() {
    if (spec.session) {
      const history = await api.transcript(spec.session).catch(() => [] as Transcript[]);
      const rows = turnsOf(history);
      if (spec.seed && !rows.some((i) => i.kind === "message" && i.m.from === "user")) rows.push(spoken("user", spec.seed, Date.now()));
      liveSession = spec.session;
      items = [...rows, ...questionsFrom(await api.needs().catch(() => [] as Need[]))];
      loading = false;
      await tick();
      holdBottom();
      return;
    }
    const [page, open, needs] = await Promise.all([api.messages(spec.agent, { limit: PAGE, task: spec.task }).catch(() => [] as LogMessage[]), api.asks().catch(() => []), api.needs().catch(() => [] as Need[])]);
    for (const a of open) openAsks.add(a.id);
    const rows: Item[] = [];
    for (const m of page) {
      seen.add(m.id);
      if (m.kind === "answer" && m.meta.askId !== undefined) answers.set(m.meta.askId, m.body);
      rows.push(messageItem(m));
      wantHeadline(m);
    }
    more = page.length >= PAGE;
    liveSession = await spec.live?.();
    if (liveSession) {
      const history = await api.transcript(liveSession).catch(() => [] as Transcript[]);
      const oldest = rows[0]?.at ?? 0;
      for (const group of groupsOf(history, liveSession)) if (group.at >= oldest - 60_000) rows.push(group);
    }
    items = rows;
    if (spec.task === undefined) items.push(...questionsFrom(needs));
    loading = false;
    await loadReads();
    openedAt = readAt(readPlace);
    await tick();
    const wanted = pendingReveal.take(spec.key);
    if (wanted) void reveal(wanted);
    else restorePlace();
    restoreReply();
  }

  async function loadEarlier() {
    const first = items.find((i): i is Row => i.kind === "message" && i.m.id > 0);
    if (!first || !log) return false;
    const older = await api.messages(spec.agent, { before: first.m.id, limit: PAGE, task: spec.task }).catch(() => [] as LogMessage[]);
    const fresh = older.filter((m) => !seen.has(m.id));
    for (const m of fresh) {
      seen.add(m.id);
      if (m.kind === "answer" && m.meta.askId !== undefined) answers.set(m.meta.askId, m.body);
    }
    more = older.length >= PAGE;
    const fromBottom = log.scrollHeight - log.scrollTop;
    items.push(...fresh.map(messageItem));
    await tick();
    log.scrollTop = log.scrollHeight - fromBottom;
    return fresh.length > 0;
  }

  /** A draft settled or changed elsewhere: the rows that draw it follow. */
  async function refreshDrafts() {
    const fresh = await api.messages(spec.agent, { limit: 20, task: spec.task }).catch(() => [] as LogMessage[]);
    for (const m of fresh) {
      const item = items.find((i): i is Row => i.kind === "message" && i.m.id === m.id);
      if (item && JSON.stringify(item.m.meta) !== JSON.stringify(m.meta)) item.m = m;
    }
    void desk.refreshNeeds();
  }

  // ---- following -----------------------------------------------------------------------------------------------

  /** pai's chat also holds every question put to him and every answer, whoever asked. */
  const concerns = (m: LogMessage) =>
    spec.session
      ? false
      : spec.task !== undefined
        ? m.taskId === spec.task
        : m.from === spec.agent || m.to === spec.agent || m.meta.agent === spec.agent || (spec.agent === PAI && (m.kind === "ask" || m.kind === "answer") && (m.to === "user" || m.from === "user"));

  function onLog(kind: string, payload: Record<string, unknown>, sessionId?: string) {
    switch (kind) {
      case "message.updated": {
        const m = payload as unknown as LogMessage;
        const item = items.find((i): i is Row => i.kind === "message" && i.m.id === m.id);
        if (item) item.m = m;
        break;
      }
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
      // A question in a session this chat does not stream (an agent's, or one pai asked before a rotation).
      case "session.question":
        if (sessionId !== liveSession && spec.task === undefined && !spec.session) void api.needs().then((needs) => questionsFrom(needs).forEach(place));
        break;
      case "session.answer":
        if (sessionId !== liveSession) {
          const q = items.find((i): i is LiveQuestion => i.kind === "question" && i.session === sessionId);
          if (q) q.answers = q.questions.map((_, i) => q.answers[i] ?? "answered");
        }
        break;
      case "main.rotated":
        if (spec.live) void spec.live().then((session) => session && (liveSession = session));
        break;
    }
  }

  /** The live session's own stream: the reply as it is written, the tool calls as they run, its questions. */
  function onLive(kind: string, ts: number, payload: { text?: string; summary?: string; name?: string; id?: string; result?: string; questions?: Question[]; answers?: Record<string, string> }) {
    const stick = nearBottom();
    if (kind === "session.delta" || kind === "session.tool") working ??= { since: ts };
    switch (kind) {
      case "session.delta":
        liveText = payload.text ?? "";
        break;
      case "session.tool": {
        if (!liveGroup) {
          // What streamed before the first call was the model thinking aloud, not the reply.
          const group: ToolGroup = { kind: "tools", key: `t${ts}`, at: ts, end: ts, thinking: liveText ?? "", tools: [], live: true, session: liveSession };
          items.push(group);
          liveGroup = items[items.length - 1] as ToolGroup;
          liveText = null;
        }
        liveGroup.end = ts;
        liveGroup.tools.push({ id: payload.id, name: payload.name ?? "tool", input: payload.summary });
        break;
      }
      case "session.tool_result": {
        if (!liveGroup) break;
        const index = liveGroup.tools.findIndex((t) => t.id === payload.id);
        if (index >= 0) liveGroup.tools[index] = { ...liveGroup.tools[index]!, result: payload.result ?? "" };
        liveGroup.end = ts;
        break;
      }
      case "session.question": {
        const q: LiveQuestion = { kind: "question", key: `q${payload.id}`, at: ts, session: liveSession ?? "", id: payload.id ?? "", questions: payload.questions ?? [], answers: [] };
        if (!items.some((i) => i.key === q.key)) items.push(q);
        break;
      }
      case "session.answer": {
        const q = items.find((i): i is LiveQuestion => i.kind === "question" && i.id === payload.id);
        if (q) q.answers = q.questions.map((question, i) => payload.answers?.[question.question] ?? q.answers[i] ?? "answered");
        break;
      }
      case "session.turn_end":
        if (liveGroup) liveGroup.live = false;
        liveGroup = undefined;
        // A plain thread has no log row to take the reply's place: the streamed text is the reply.
        if (spec.session && liveText) items.push(spoken(spec.agent, liveText, ts));
        if (spec.session) liveText = null;
        working = null;
        break;
      case "session.exit":
        liveGroup = undefined;
        working = null;
        break;
      default:
        return;
    }
    if (stick) void scrollSoon(true);
  }

  $effect(() => {
    void load();
    const stop = stream.on((event) => {
      if (event.sessionId && event.sessionId === liveSession && event.kind.startsWith("session.")) onLive(event.kind, event.ts, event.payload);
      onLog(event.kind, event.payload, event.sessionId);
    });
    const timer = setInterval(() => working && (now = Date.now()), 1000);
    return () => {
      stop();
      clearInterval(timer);
      flushReads();
    };
  });

  // ---- reading: a row is read once it has been on screen for half a second ------------------------------------

  const dwelling = new Map<Element, ReturnType<typeof setTimeout>>();
  let watcher: IntersectionObserver | undefined;
  $effect(() => {
    if (!log) return;
    watcher = new IntersectionObserver(
      (list) => {
        for (const entry of list) {
          const at = Number((entry.target as HTMLElement).dataset.at ?? 0);
          if (!at) continue;
          if (!entry.isIntersecting) {
            clearTimeout(dwelling.get(entry.target));
            dwelling.delete(entry.target);
            continue;
          }
          if (dwelling.has(entry.target)) continue;
          dwelling.set(
            entry.target,
            setTimeout(() => {
              dwelling.delete(entry.target);
              markRead(readPlace, at);
              (entry.target as HTMLElement).classList.remove("unread");
            }, DWELL_MS),
          );
        }
      },
      { root: log, threshold: 0.6 },
    );
    return () => {
      watcher?.disconnect();
      for (const t of dwelling.values()) clearTimeout(t);
      dwelling.clear();
    };
  });
  /** A row that counts: dotted while unseen, watched for its half second on screen. */
  const readable = (item: Item) => (node: HTMLElement) => {
    if (!said(item)) return;
    if (item.at > openedAt && item.at > readAt(readPlace)) node.classList.add("unread");
    watcher?.observe(node);
    return () => watcher?.unobserve(node);
  };

  // ---- the top of the list: older rows load as it nears the view ----------------------------------------------

  $effect(() => {
    if (!loader || !log) return;
    let running = false;
    const observer = new IntersectionObserver(
      async (list) => {
        if (running || !list.some((e) => e.isIntersecting)) return;
        running = true;
        await loadEarlier();
        running = false;
      },
      { root: log, rootMargin: "800px 0px 0px 0px" },
    );
    observer.observe(loader);
    return () => observer.disconnect();
  });

  // ---- scrolling: held at the bottom while the rows settle, the place remembered -------------------------------

  let holding: number | undefined;
  let settled = false;
  function holdBottom(ms = 2000) {
    const until = Date.now() + ms;
    const step = () => {
      scroll();
      holding = Date.now() < until ? requestAnimationFrame(step) : undefined;
    };
    if (holding !== undefined) cancelAnimationFrame(holding);
    scroll();
    holding = requestAnimationFrame(step);
    setTimeout(() => (settled = true), ms + 100);
  }
  function letGo() {
    if (holding !== undefined) cancelAnimationFrame(holding);
    holding = undefined;
  }
  /** Back where he left off, if that row is still there; the bottom otherwise. */
  function restorePlace() {
    const id = recallRaw(placeKey);
    const row = id ? log?.querySelector<HTMLElement>(`[data-message="${id}"]`) : undefined;
    if (!row) return holdBottom();
    const until = Date.now() + 2000;
    const step = () => {
      row.scrollIntoView({ block: "start" });
      if (Date.now() < until && holding !== undefined) holding = requestAnimationFrame(step);
    };
    holding = requestAnimationFrame(step);
    setTimeout(() => ((settled = true), letGo()), 2100);
  }
  let placing: ReturnType<typeof setTimeout> | undefined;
  let dayTimer: ReturnType<typeof setTimeout> | undefined;
  let barTimer: ReturnType<typeof setTimeout> | undefined;
  function onscroll() {
    if (!log) return;
    atBottom = nearBottom();
    // The day of the row at the top of the view, for a moment.
    const top = log.getBoundingClientRect().top + 60;
    const first = [...log.querySelectorAll<HTMLElement>("[data-at]")].find((row) => row.getBoundingClientRect().bottom > top);
    if (first) {
      day = dayLabel(Number(first.dataset.at));
      dayShown = true;
      clearTimeout(dayTimer);
      dayTimer = setTimeout(() => (dayShown = false), 1500);
    }
    drawBar();
    barMoving = true;
    clearTimeout(barTimer);
    barTimer = setTimeout(() => (barMoving = false), 800);
    if (!settled) return;
    clearTimeout(placing);
    placing = setTimeout(() => {
      if (!log) return;
      const edge = log.getBoundingClientRect().top;
      const row = [...log.querySelectorAll<HTMLElement>("[data-message]")].find((r) => r.getBoundingClientRect().bottom > edge);
      if (nearBottom() || !row?.dataset.message) forget(placeKey);
      else remember(placeKey, row.dataset.message);
    }, 200);
  }

  // ---- the scrollbar: the log's own is hidden (it reaches past the column), so a thin thumb stands for it ------

  function drawBar() {
    if (!log || !scrollbar || !thumb) return;
    scrollbar.hidden = false;
    const track = scrollbar.clientHeight;
    const room = log.scrollHeight - log.clientHeight;
    if (room <= 0 || !track) return void (scrollbar.hidden = true);
    const height = Math.max(28, (log.clientHeight / log.scrollHeight) * track);
    thumb.style.height = `${height}px`;
    thumb.style.transform = `translateY(${(log.scrollTop / room) * (track - height)}px)`;
  }
  $effect(() => {
    if (!log) return;
    const observer = new ResizeObserver(drawBar);
    observer.observe(log);
    return () => observer.disconnect();
  });
  function dragThumb(down: PointerEvent) {
    if (!thumb || !log || !scrollbar) return;
    down.preventDefault();
    const handle = thumb;
    handle.setPointerCapture(down.pointerId);
    barDragging = true;
    const startY = down.clientY;
    const startTop = log.scrollTop;
    const move = (event: PointerEvent) => {
      if (!log || !scrollbar) return;
      const track = scrollbar.clientHeight - handle.offsetHeight;
      if (track > 0) log.scrollTop = startTop + ((event.clientY - startY) / track) * (log.scrollHeight - log.clientHeight);
    };
    const up = () => {
      barDragging = false;
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  }
  /** The track beside the thumb pages towards the press, as a native bar does. */
  function pageTrack(event: PointerEvent) {
    if (event.target !== scrollbar || !thumb || !log) return;
    const above = event.clientY < thumb.getBoundingClientRect().top;
    log.scrollBy({ top: (above ? -1 : 1) * log.clientHeight * 0.9, behavior: "smooth" });
  }

  // ---- acting on a row: a right click opens its menu, a two-finger swipe to the left replies -------------------

  const rowMessage = (row: HTMLElement) => items.find((i): i is Row => i.kind === "message" && i.m.id === Number(row.dataset.message))?.m;

  function contextmenu(event: MouseEvent) {
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-message]");
    const m = row && rowMessage(row);
    if (!m) return;
    event.preventDefault();
    const selected = window.getSelection()?.toString().trim();
    const link = m.meta.link ?? /https?:\/\/[^\s)>\]]+/.exec(m.body)?.[0];
    const copy = (text: string) => void navigator.clipboard.writeText(text);
    menus.openContext(event.clientX, event.clientY, [
      { label: "Reply", icon: "reply", run: () => startReply(m) },
      ...(selected ? [{ label: "Copy selection", icon: "copy" as const, run: () => copy(selected) }] : []),
      { label: "Copy text", icon: "copy", run: () => copy(textOf(m)) },
      ...(link ? [{ label: "Copy link", icon: "link" as const, run: () => copy(link) }] : []),
    ]);
  }

  let swipe: { row: HTMLElement; m: LogMessage; dx: number; timer: ReturnType<typeof setTimeout> } | undefined;
  function endSwipe() {
    if (!swipe) return;
    const { row, m, dx } = swipe;
    swipe = undefined;
    row.classList.remove("swiping", "armed");
    row.style.transform = "";
    row.style.removeProperty("--swipe");
    row.querySelector(":scope > .swipe-reply")?.remove();
    if (dx >= SWIPE_REPLY) startReply(m);
  }
  function wheel(event: WheelEvent) {
    letGo();
    if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
    // A code block or a table wider than the row scrolls sideways as it always did.
    for (let node = event.target as HTMLElement | null; node && node !== log; node = node.parentElement) if (node.scrollWidth > node.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(node).overflowX)) return;
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-message]");
    const m = row && rowMessage(row);
    if (!row || !m) return;
    event.preventDefault();
    if (swipe && swipe.row !== row) endSwipe();
    if (!swipe) {
      swipe = { row, m, dx: 0, timer: setTimeout(endSwipe, 0) };
      row.classList.add("swiping");
      const mark = document.createElement("span");
      mark.className = "swipe-reply";
      mark.innerHTML = '<svg class="icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 18v-2a4 4 0 0 0-4-4H4"/><path d="m9 17-5-5 5-5"/></svg>';
      row.append(mark);
    }
    clearTimeout(swipe.timer);
    swipe.dx = Math.max(0, Math.min(SWIPE_MAX, swipe.dx + event.deltaX));
    // Past the point that replies the row follows the fingers less, so the threshold is felt.
    const shown = swipe.dx <= SWIPE_REPLY ? swipe.dx : SWIPE_REPLY + (swipe.dx - SWIPE_REPLY) * 0.35;
    row.style.transform = `translateX(${-shown}px)`;
    row.style.setProperty("--swipe", String(Math.min(1, swipe.dx / SWIPE_REPLY)));
    row.classList.toggle("armed", swipe.dx >= SWIPE_REPLY);
    swipe.timer = setTimeout(endSwipe, 160);
  }

  function flash(node: HTMLElement) {
    node.scrollIntoView({ block: "center", behavior: "smooth" });
    node.classList.remove("flash");
    void node.offsetWidth;
    node.classList.add("flash");
  }

  /** Scrolls to a row and flashes it, paging back through the log until it is there; false when this chat does not hold it. */
  export async function reveal(target: RevealTarget): Promise<boolean> {
    const selector = target.messageId !== undefined ? `[data-message="${target.messageId}"]` : target.askId !== undefined ? `[data-ask="${target.askId}"]` : target.taskId !== undefined ? `[data-task="${target.taskId}"]` : target.question ? ".row.question.open" : "";
    if (!selector || !log) return false;
    letGo();
    const lookup = () => [...(log?.querySelectorAll<HTMLElement>(selector) ?? [])].pop();
    let found = lookup();
    while (!found && more) {
      if (!(await loadEarlier())) break;
      found = lookup();
    }
    if (!found) {
      // A row folded into a group of events: the group opens first.
      const id = target.messageId;
      const group = entries.find((e) => e.type === "group" && e.rows.some((r) => r.m.id === id));
      if (group) {
        openKeys.add(group.key);
        await tick();
        found = lookup();
      }
    }
    if (!found) return false;
    found.closest<HTMLElement>(".row.group")?.classList.add("open");
    flash(found);
    return true;
  }
  export const focus = () => box?.focus();
  export const setNote = (text: string) => box?.setNote(text);
  export const setPlaceholder = (text?: string) => box?.setPlaceholder(text);
  export const refreshPrefs = () => box?.refreshPrefs();

  // ---- ⌘F: the chat's own find, while it is what he is looking at -----------------------------------------------

  const findTargets = (): FindTarget[] =>
    items
      .map((item) => ({ item, text: item.kind === "message" ? textOf(item.m) : item.kind === "tools" ? describeTools(item.tools) : item.questions.map((q) => q.question).join("\n") }))
      .filter(({ text }) => text.trim())
      .sort((a, b) => a.item.at - b.item.at)
      .map(({ item, text }) => ({
        key: item.key,
        text,
        reveal: async () => {
          openKeys.add(item.key);
          const group = entries.find((e) => e.type === "group" && e.rows.some((r) => r.key === item.key));
          if (group) openKeys.add(group.key);
          await tick();
          const row = log?.querySelector<HTMLElement>(`[data-key="${item.key}"]`) ?? undefined;
          row?.classList.remove("folded");
          return row;
        },
      }));

  function keydown(event: KeyboardEvent) {
    if (event.key !== "f" || !(event.metaKey || event.ctrlKey) || event.altKey || !log?.offsetParent) return;
    event.preventDefault();
    if (find?.showing() && event.shiftKey) void find.step(-1);
    else find?.open();
  }

  /** The find bar hangs under the crumbs rather than over the column: it is part of the header there. */
  const portal = (selector: string) => (node: HTMLElement) => {
    const target = document.querySelector(selector);
    if (target) target.append(node);
    return () => node.remove();
  };
</script>

<svelte:window onkeydown={keydown} />

<div style="display: contents" {@attach portal(".crumb-under")}>
  <FindBar bind:this={find} scope={() => log} targets={findTargets} anchorKey={() => {
    const top = log?.getBoundingClientRect().top ?? 0;
    return [...(log?.querySelectorAll<HTMLElement>("[data-key]") ?? [])].find((r) => r.getBoundingClientRect().bottom > top)?.dataset.key;
  }} canLoadMore={() => more} loadMore={loadEarlier} />
</div>

<section class="chat">
  <div class="chat-view">
    <div class="chat-head"><span class="chat-daypill" class:shown={dayShown}>{day}</span></div>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="chat-log" bind:this={log} {onscroll} onwheel={wheel} ontouchstart={letGo} oncontextmenu={contextmenu} data-testid="messages">
      {#if more}<div class="list-loader" role="progressbar" aria-label="Loading earlier messages" bind:this={loader}><span class="spinner"></span></div>{/if}
      {#each entries as entry (entry.key)}
        {#if entry.type === "day"}
          <div class="day" {@attach rowAttach(entry.key)}><span>{entry.label}</span></div>
        {:else if entry.type === "new"}
          <div class="new-line"><span>New</span></div>
        {:else if entry.type === "group"}
          {@const first = entry.rows[0]!.m}
          {@const last = entry.rows[entry.rows.length - 1]!.m}
          <div class="row pill event group tint-muted" class:open={openKeys.has(entry.key)} data-at={first.createdAt} data-key={entry.key} {@attach rowAttach(entry.key)}>
            <button class="pill-line" onclick={() => ctx.toggle(entry.key)}>
              <Icon name={eventIcon(first)} size={10} />
              <span class="pill-text">{entry.rows.length} {typeLabel(eventType(first))}</span>
              <span class="when">{new Date(last.createdAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })}</span>
              <Icon name="chevron" size={9} />
            </button>
            <div class="event-body group-body">
              {#if openKeys.has(entry.key)}
                {#each entry.rows as row (row.key)}<MessageRow m={row.m} {ctx} key={row.key} />{/each}
              {/if}
            </div>
          </div>
        {:else if entry.item.kind === "tools"}
          {@const group = entry.item}
          <ToolsRow {group} open={openKeys.has(group.key)} ontoggle={() => ctx.toggle(group.key)} attach={rowAttach(entry.key)} />
        {:else if entry.item.kind === "question"}
          <QuestionRow q={entry.item} {ctx} attach={rowAttach(entry.key)} />
        {:else}
          {@const row = entry.item}
          <MessageRow m={row.m} {ctx} key={row.key} attach={rowAttach(entry.key, row)} />
        {/if}
      {/each}
      {#each pending as p (p.id)}
        <div class="row mine" class:pending={p.state === "sending"} class:failed={p.state === "failed"} data-kind="user">
          <Pictures images={p.images} />
          <div class="mine-text">
            {#if p.quote}<QuoteRef quote={p.quote} onjump={ctx.jump} />{/if}
            {#if p.text}<div class="bubble" {@attach mdTimed(p.text, Date.now())}></div>{/if}
            <div class="row-foot"><span class="grow"></span><span>{p.state === "failed" ? "not sent" : p.state}</span></div>
          </div>
        </div>
      {/each}
      {#if liveText !== null}
        <div class="row reply live" data-testid="live-turn"><div class="bubble" {@attach mdTimed(liveText, Date.now())}></div></div>
      {/if}
      {#if working}
        <div class="row working"><span class="spinner"></span><b>Working on it…</b><span class="elapsed">{duration(now - working.since)}</span></div>
      {/if}
      {#if !loading && !items.length && !pending.length}<p class="hint">Nothing said here yet.</p>{/if}
    </div>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="chat-scrollbar" class:moving={barMoving} class:dragging={barDragging} bind:this={scrollbar} onpointerdown={pageTrack} hidden>
      <div class="thumb" bind:this={thumb} onpointerdown={dragThumb}></div>
    </div>
    <div class="chat-foot">
      <div class="chat-foot-side">
        {#if !atBottom}<button class="to-bottom" title="to the latest" aria-label="To the latest" onclick={() => log?.scrollTo({ top: log.scrollHeight, behavior: "smooth" })}><Icon name="chevron" size={13} /></button>{/if}
        <div class="chat-slot">{@render slot?.()}</div>
      </div>
      <Compose bind:this={box} placeholder={spec.placeholder} draftKey={spec.key} session={() => liveSession} prefs={spec.prefs} setPrefs={spec.setPrefs} {extra} disabled={spec.disabled} {submit} />
    </div>
  </div>
</section>
