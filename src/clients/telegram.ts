import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import { markdownToTelegramHtml, splitMessage } from "@elumixor/react-telegram";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { db, kv as store, now } from "../core/db.ts";
import { bus, type PaiEvent } from "../core/bus.ts";
import * as sessions from "../domain/sessions.ts";
import * as held from "../domain/held.ts";
import { transcript } from "../domain/transcript.ts";
import type { Question, Session } from "../domain/session.ts";
import { logger } from "../core/log.ts";
import { EVENT_ICONS, MARKER, PROTOCOL_VERSION, trailerUrl, type RichEvent, type RichMeta, type RichTool } from "../protocol/rich.ts";
import * as main from "../domain/main.ts";
import * as agents from "../domain/agents.ts";
import * as asks from "../domain/asks.ts";
import * as tasks from "../domain/tasks.ts";
import type { Message as LogRow } from "../domain/messages.ts";
import { readable } from "../domain/attachments.ts";
import { describePlace, placeOf } from "../domain/location.ts";
import * as connectors from "../connectors/loader.ts";

const log = logger("telegram");

/** A thread the chat shows: one the daemon runs, or one held elsewhere (a terminal's, pai-dev). */
type Thread = Session | held.HeldThread;
const findThread = (id: string): Thread | undefined => sessions.find(id) ?? held.find(id);

/** What the bot needs: the token, the one chat it serves, where files go. */
export interface BotConfig {
  readonly token: string;
  readonly chatId: number;
  readonly baseUrl: string;
  readonly inbox: string;
}

const MAIN_THREAD = "main_thread_id";
const HISTORY_MESSAGES = 10;
let config: BotConfig;
/** The bot's own state, under the prefix it had while it lived in the telegram module, so a release keeps its topics. */
const KV_PREFIX = "module:telegram:";
const kv = { get: (k: string) => store.get(KV_PREFIX + k), set: (k: string, v: string) => store.set(KV_PREFIX + k, v) };

/** Voice is transcribed by Telegram itself, through his own account: the telegram connector's. */
const transcribe = async (chatId: number, messageId: number) => {
  const telegram = connectors.api<{ transcribe(chatId: number | string, messageId: number): Promise<string> }>("telegram");
  if (!telegram) throw new Error("the telegram connector (his account) is not loaded");
  return telegram.transcribe(chatId, messageId);
};
const STATUS = { starting: "🔵", busy: "🔵", idle: "🟢", waiting: "🟡", dead: "⚪", error: "🔴" } as const;
let notifier: ((text: string) => Promise<void>) | undefined;

/** A message to the user in the root chat, from the daemon itself rather than a session. */
export async function notify(text: string) {
  if (!notifier) throw new Error("telegram is off; nothing to notify with");
  await notifier(text);
}

export function startTelegram(cfg: BotConfig) {
  config = cfg;
  mkdirSync(config.inbox, { recursive: true });

  const bot = new Bot(config.token);
  bot.api.config.use(apiThrottler());
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3 }));
  const chatId = config.chatId;
  const tg = new Frontend(bot, chatId);
  notifier = async (text) => {
    const thread = tg.topics ? await tg.ensureMainTopic() : undefined;
    await bot.api.sendMessage(chatId, text.slice(0, 4000), { message_thread_id: thread, link_preview_options: { is_disabled: true } });
  };

  bot.on("message", async (ctx) => {
    if (ctx.chat.id !== chatId) return;
    try {
      await tg.inbound(ctx);
    } catch (err) {
      log.error("inbound failed", err);
      await ctx.reply(`error: ${(err as Error).message}`, { message_thread_id: threadOf(ctx) }).catch(() => {});
    }
  });

  bot.on("callback_query:data", async (ctx) => {
    if (ctx.chat?.id !== chatId) return;
    await tg.callback(ctx).catch((err) => log.error("callback failed", err));
  });

  bus.on("event", (e: PaiEvent) => tg.take(e));
  // The daemon's own notices to the user (automations, updates) come as events.
  bus.on("event", (e: PaiEvent) => {
    if (e.kind === "user.notify" && typeof e.payload.text === "string") void notify(e.payload.text).catch((err) => log.warn("notify failed", (err as Error).message));
  });

  bot.catch((err) => log.error("bot error", err.message));
  void (async () => {
    const me = await bot.api.getMe();
    tg.topics = Boolean(me.has_topics_enabled) || Boolean(kv.get(MAIN_THREAD));
    tg.username = me.username;
    log.info(`@${me.username}, topics ${tg.topics ? "on" : "off (enable in @BotFather → Bot Settings → Threads Settings)"}`);
    if (tg.topics) {
      main.setThread((await tg.ensureMainTopic()) ?? null);
      await tg.ensureAgentTopics();
    }
    await bot.api.setMyCommands([
      { command: "tasks", description: "what is on your plate" },
      { command: "agents", description: "pai and its staff" },
      { command: "asks", description: "what the agents are waiting on you for" },
      { command: "threads", description: "threads running and recent" },
      { command: "new", description: "start a thread in a new topic: /new <title>" },
      { command: "stop", description: "interrupt this session" },
    ]);
    // A second poller on the same token makes getUpdates fail with 409, which used to
    // reject out of here and take the whole daemon down. Keep retrying instead: the
    // other instance is usually a stale process that goes away on its own.
    for (;;) {
      try {
        await bot.start({ drop_pending_updates: true, onStart: () => log.info("polling") });
        return;
      } catch (err) {
        log.error("polling stopped", (err as Error).message);
        await new Promise((r) => setTimeout(r, 15_000));
      }
    }
  })().catch((err) => log.error("telegram startup failed", (err as Error).message));
  running = {
    stop: () => bot.stop(),
    /** What a client needs to find the chat: the bot is public, the chat id is not. */
    info: () => ({ botUsername: tg.username, mainThread: main.thread() }),
  };
  return running;
}

let running: { stop(): Promise<void>; info(): { botUsername?: string; mainThread: number | null } } | undefined;
/** The bot's public face for clients (Paigram reads it at `/m/telegram/info`); undefined while it is off. */
export const info = () => running?.info();

function threadOf(ctx: Context): number | undefined {
  const m = ctx.message ?? ctx.callbackQuery?.message;
  return m?.is_topic_message ? m.message_thread_id : undefined;
}

/** Streaming state for one session's current turn. */
interface Outbox {
  draftId: number;
  lastText: string;
  lastSent: number;
  timer?: ReturnType<typeof setTimeout>;
  keepalive?: ReturnType<typeof setInterval>;
}

/** The trailer must stay well under the message limit; a turn rarely needs more than this many tool lines. */
const MAX_TRAILER_TOOLS = 40;
const MAX_TOOL_DETAIL = 80;

class Frontend {
  topics = false;
  username = "";
  private outboxes = new Map<string, Outbox>();
  /** The tools of the turn in progress, per session, for the final message's metadata. */
  private turnTools = new Map<string, RichTool[]>();
  private turnStarted = new Map<string, number>();
  private cardTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** In-progress multiSelect picks, keyed by `${shortId}:${questionIndex}`, cleared on Done. */
  private selections = new Map<string, Set<number>>();

  constructor(
    private bot: Bot,
    private chatId: number,
  ) {}

  // ---- inbound -------------------------------------------------------------

  async inbound(ctx: Context) {
    const msg = ctx.message!;
    const threadId = threadOf(ctx) ?? null;
    const text = projectPrefix(msg.text ?? msg.caption ?? "").text;

    // Service messages (topic created/edited, pins) and the bot's own messages are not turns.
    if (msg.from?.is_bot || msg.forum_topic_created || msg.forum_topic_edited || msg.pinned_message) return;
    if (threadId !== null && !this.topics) {
      // getMe lags behind the BotFather switch; a threaded message is proof enough.
      this.topics = true;
      await this.ensureMainTopic();
    }

    if (text.startsWith("/")) {
      const handled = await this.command(ctx, text, threadId);
      if (handled) return;
    }


    const images = await this.attachments(ctx);
    const place = placeOf(msg);
    const body = [text, images.note, place ? describePlace(place) : ""].filter(Boolean).join("\n\n").trim();
    if (!body && images.images.length === 0) return;

    // A reply to an ask card answers it, with no turn for pai.
    const replyTo = msg.reply_to_message?.message_id;
    const askId = replyTo ? Number(kv.get(`ask:${replyTo}`) ?? 0) : 0;
    if (askId && asks.getAsk(askId)?.status === "open") {
      try {
        asks.answer(askId, body);
      } catch (err) {
        await ctx.reply((err as Error).message, { message_thread_id: threadId ?? undefined });
      }
      return;
    }

    // pai's chat: the main topic, and anything outside a topic.
    if (threadId === null ? !this.replyTarget(ctx) : threadId === this.mainThread()) {
      main.send(body, { images: images.images, place });
      return;
    }
    // An agent's own chat: a message to that agent, and pai hears that the user stepped in.
    const agent = threadId !== null ? agents.byThread(threadId) : undefined;
    if (agent && agent.status !== "closed") {
      agents.fromUser(agent.slug, body);
      return;
    }

    const session = this.route(ctx, threadId);
    if (session.pending) {
      session.answer(body);
      return;
    }
    session.send(body, { images: images.images });
  }

  /** A message outside topics that replies to a thread's message goes to that thread. */
  private replyTarget(ctx: Context): Session | undefined {
    const replyTo = ctx.message?.reply_to_message?.message_id;
    if (!replyTo) return undefined;
    const linked = db.query("SELECT session_id FROM tg_messages WHERE message_id = ?").get(replyTo) as { session_id: string } | undefined;
    if (!linked || main.isMain(linked.session_id)) return undefined;
    return sessions.ensureLive(linked.session_id);
  }

  /**
   * In threaded mode the main conversation lives in its own topic, since every message the user
   * types outside a topic opens a new one. Created once, remembered in kv.
   */
  async ensureMainTopic() {
    const known = kv.get(MAIN_THREAD);
    if (known) return Number(known);
    try {
      const topic = await this.bot.api.createForumTopic(this.chatId, "💬 pai");
      kv.set(MAIN_THREAD, String(topic.message_thread_id));
      await this.bot.api.sendMessage(this.chatId, "A conversation with pai. Every topic is one; typing in a new topic starts another.", {
        message_thread_id: topic.message_thread_id,
      });
      return topic.message_thread_id;
    } catch (err) {
      log.warn("could not create main topic", (err as Error).message);
      return undefined;
    }
  }

  private mainThread(): number | null {
    const v = kv.get(MAIN_THREAD);
    return v ? Number(v) : null;
  }

  /** pai's one chat. */
  private general(): Session {
    return main.session();
  }

  /** Every standing and service agent has a topic of its own; sub-agents post into their parent's. */
  async ensureAgentTopics() {
    for (const a of agents.list()) if (a.kind === "standing" || a.kind === "service") await this.agentTopic(a);
  }

  private topicsInFlight = new Map<string, Promise<number | null>>();

  /** The agent's own topic, made once even when its creation and its first session ask at the same moment. */
  private agentTopic(a: agents.Agent): Promise<number | null> {
    const fresh = agents.get(a.slug) ?? a;
    if (fresh.threadId !== null || !this.topics || fresh.status === "closed") return Promise.resolve(fresh.threadId);
    const inFlight = this.topicsInFlight.get(a.slug);
    if (inFlight) return inFlight;
    const made = this.makeAgentTopic(fresh).finally(() => this.topicsInFlight.delete(a.slug));
    this.topicsInFlight.set(a.slug, made);
    return made;
  }

  private async makeAgentTopic(a: agents.Agent): Promise<number | null> {
    try {
      const topic = await this.bot.api.createForumTopic(this.chatId, a.name.slice(0, 128));
      agents.setThread(a.slug, topic.message_thread_id);
      await this.bot.api.sendMessage(this.chatId, `${esc(a.name)} — ${esc(a.brief.split("\n")[0]!.slice(0, 300))}\n\n<i>Writing here talks to ${esc(a.name)} directly; pai hears that you stepped in.</i>`, {
        parse_mode: "HTML",
        message_thread_id: topic.message_thread_id,
        disable_notification: true,
      });
      return topic.message_thread_id;
    } catch (err) {
      log.warn(`topic for ${a.slug}: ${(err as Error).message}`);
      return null;
    }
  }

  /** The topic a message-log party's rows go to: pai's chat for pai and the user, an agent's own (or its parent's) otherwise. */
  private chatOf(party: string): number | null {
    const a = agents.get(party);
    if (!a || a.kind === "orchestrator") return this.mainThread();
    if (a.threadId !== null) return a.threadId;
    return a.parent ? this.chatOf(a.parent) : this.mainThread();
  }

  /** Which session a message belongs to: its topic, the message it replies to, or the "pai" topic's. */
  private route(ctx: Context, threadId: number | null): Thread {
    if (threadId !== null && threadId === this.mainThread()) return this.general();
    if (threadId !== null) {
      const a = agents.byThread(threadId);
      const s = a?.sessionId ? sessions.ensureLive(a.sessionId) : undefined;
      if (s) return s;
    }
    if (threadId !== null) {
      const existing = held.byThread(threadId) ?? sessions.byThread(threadId);
      if (existing) return existing;
      const created = ctx.message?.reply_to_message?.forum_topic_created;
      const { project, text } = projectPrefix(ctx.message?.text ?? ctx.message?.caption ?? "");
      const name = created && !created.is_name_implicit ? created.name : text.replace(/\s+/g, " ").slice(0, 40) || `topic ${threadId}`;
      try {
        return sessions.spawnTask({ title: name, threadId, project });
      } catch (err) {
        log.warn(`project "${project}" refused, starting in the workspace: ${(err as Error).message}`);
        return sessions.spawnTask({ title: name, threadId });
      }
    }
    const replyTo = ctx.message?.reply_to_message?.message_id;
    if (replyTo) {
      const linked = db.query("SELECT session_id FROM tg_messages WHERE message_id = ?").get(replyTo) as
        | { session_id: string }
        | undefined;
      const s = linked ? sessions.ensureLive(linked.session_id) : undefined;
      if (s) return s;
    }
    return this.general();
  }

  private async command(ctx: Context, text: string, threadId: number | null): Promise<boolean> {
    const [cmd, ...rest] = text.split(/\s+/);
    const arg = rest.join(" ").trim();
    const reply = (t: string) => ctx.reply(t, { parse_mode: "HTML", message_thread_id: threadId ?? undefined });
    switch (cmd?.replace(/@\w+$/, "")) {
      case "/start":
        await reply("pai here. Talk to me here; my agents work in their own topics and report back to me.");
        return true;
      case "/new": {
        if (!arg) {
          await reply("usage: /new &lt;title&gt;");
          return true;
        }
        const s = sessions.spawnTask({ title: arg });
        if (!this.topics) await reply(`started ${this.tag(s)} — reply to its messages to talk to it`);
        return true;
      }
      case "/tasks": {
        const items = tasks.list({ limit: 30 });
        await reply(items.length ? items.map((t) => `<b>#${t.id}</b> ${esc(t.title)} · ${esc(t.status.replace("_", " "))} · ${esc(agents.get(t.owner)?.name ?? t.owner)}${t.due ? ` · due ${t.due}` : ""}`).join("\n") : "nothing on your plate");
        return true;
      }
      case "/agents": {
        const open = tasks.openCounts();
        const lines = agents.list().map((a) => `${"  ".repeat(Math.max(0, agents.depth(a.slug) - 1))}${AGENT_STATUS[a.status] ?? "⚪"} <b>${esc(a.name)}</b> ${esc(a.status)}${open[a.slug] ? ` · ${open[a.slug]} open` : ""}${a.turnsToday ? ` · ${a.turnsToday} turns today` : ""}`);
        await reply(lines.join("\n"));
        return true;
      }
      case "/asks": {
        const open = asks.open();
        await reply(open.length ? open.map((a) => `<b>#${a.id}</b> ${esc(agents.breadcrumb(a.agent))}: ${esc(a.question)}`).join("\n") : "nothing waiting on you");
        return true;
      }
      case "/threads": {
        const rows = sessions.recent(12);
        if (rows.length === 0) {
          await reply("no tasks yet");
          return true;
        }
        const lines = rows.map((t) => {
          const live = sessions.find(t.sessionId);
          const st = live?.pending ? "waiting" : t.state;
          return `${STATUS[st as keyof typeof STATUS] ?? "⚪"} <b>${esc(t.title)}</b> <code>${t.shortId}</code> ${st}${t.project ? ` · ${esc(t.project)}` : ""}`;
        });
        await reply(lines.join("\n"));
        return true;
      }
      case "/stop": {
        const s = threadId !== null && threadId !== this.mainThread() ? (held.byThread(threadId) ?? sessions.byThread(threadId)) : this.general();
        const did = await s?.interrupt();
        await reply(did ? "interrupted" : "nothing running");
        return true;
      }
      default:
        return false; // unknown slash text goes to the model like anything else
    }
  }

  /** Saves photos/documents/voice notes to the inbox; photos go to the model inline, voice gets transcribed. */
  private async attachments(ctx: Context) {
    const msg = ctx.message!;
    /** Pictures and documents alike: the daemon keeps each by hash and tells the model how to read it. */
    const images: { media_type: string; data: string; name?: string }[] = [];
    const notes: string[] = [];
    const photo = msg.photo?.at(-1);
    const doc = msg.document;
    const voice = msg.voice ?? msg.audio;
    const fileMeta = photo ?? doc ?? voice;
    if (!fileMeta) return { images, note: "" };
    const file = await ctx.api.getFile(fileMeta.file_id);
    const name = doc?.file_name ?? (voice ? `voice-${now()}.ogg` : `${photo ? "photo" : "file"}-${now()}${photo ? ".jpg" : ""}`);
    const path = join(config.inbox, name.replace(/[^\w.-]+/g, "_"));
    const res = await fetch(`https://api.telegram.org/file/bot${config.token}/${file.file_path}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    await Bun.write(path, bytes);

    if (voice) {
      // Telegram transcribes it (Premium), through the user's own account, which is in this chat too.
      try {
        const text = await transcribe(this.chatId, msg.message_id);
        notes.push(text ? `[voice message: "${text}"]` : "[voice message: nothing recognized]");
      } catch (err) {
        log.warn("transcribe failed", (err as Error).message);
        notes.push(`[voice message saved: ${path} — transcription failed: ${(err as Error).message}]`);
      }
      return { images, note: notes.join("\n") };
    }

    const mime = doc?.mime_type ?? (photo ? "image/jpeg" : "application/octet-stream");
    const data = Buffer.from(bytes).toString("base64");
    const refusal = readable({ media_type: mime, data, name });
    if (refusal) {
      // Saying so here is the point: a turn that opens a zip and gives up tells him nothing.
      notes.push(`[${name} saved to ${path} — ${refusal}]`);
      return { images, note: notes.join("\n") };
    }
    // A document goes through the same store as a picture, so the row names it and the model reads it.
    images.push({ media_type: mime, data, name });
    if (!photo && !mime.startsWith("image/")) notes.push(`[${name} also saved to ${path}]`);
    return { images, note: notes.join("\n") };
  }

  async callback(ctx: Context) {
    const data = ctx.callbackQuery!.data!;
    const [kind, short, qiStr, oiStr] = data.split(":");
    // An ask card's button: k:<askId>:<option>.
    if (kind === "k") {
      const a = asks.getAsk(Number(short));
      const option = a?.options[Number(qiStr)];
      if (!a || a.status !== "open" || !option) return void ctx.answerCallbackQuery({ text: "that question is no longer open" });
      try {
        asks.answer(a.id, option);
        await ctx.answerCallbackQuery({ text: option });
      } catch (err) {
        await ctx.answerCallbackQuery({ text: (err as Error).message.slice(0, 190) });
      }
      return;
    }
    const s = sessions.find(short!);
    const p = s?.pending;
    if (!s || !p) {
      await ctx.answerCallbackQuery({ text: "that question is no longer open" });
      return;
    }
    const qi = Number(qiStr);
    const q = p.questions[qi];
    if (!q) return void ctx.answerCallbackQuery();

    if (kind === "a") {
      const option = q.options[Number(oiStr)];
      if (!option) return void ctx.answerCallbackQuery();
      s.answer(option.label, qi);
      await ctx.answerCallbackQuery({ text: option.label });
      await this.markAnswered(ctx, q, option.label);
      return;
    }

    const key = `${short}:${qi}`;
    if (kind === "t") {
      const oi = Number(oiStr);
      const set = this.selections.get(key) ?? new Set<number>();
      if (set.has(oi)) set.delete(oi);
      else set.add(oi);
      this.selections.set(key, set);
      await ctx.answerCallbackQuery({ text: set.has(oi) ? `+ ${q.options[oi]?.label}` : `- ${q.options[oi]?.label}` });
      await ctx.editMessageReplyMarkup({ reply_markup: this.multiKeyboard(s, q, qi, set) }).catch(() => {});
      return;
    }

    if (kind === "d") {
      const set = this.selections.get(key);
      this.selections.delete(key);
      const labels = q.options.filter((_, oi) => set?.has(oi)).map((o) => o.label);
      if (labels.length === 0) return void ctx.answerCallbackQuery({ text: "pick at least one" });
      s.answer(labels.join(", "), qi);
      await ctx.answerCallbackQuery({ text: labels.join(", ") });
      await this.markAnswered(ctx, q, labels.join(", "));
      return;
    }

    await ctx.answerCallbackQuery();
  }

  private async markAnswered(ctx: Context, q: Question, answerText: string) {
    const m = ctx.callbackQuery!.message;
    if (m && "text" in m)
      await ctx.api
        .editMessageText(this.chatId, m.message_id, `${questionText(q)}\n\n→ <b>${esc(answerText)}</b>`, { parse_mode: "HTML" })
        .catch(() => {});
  }

  private multiKeyboard(s: Thread, q: Question, qi: number, set: Set<number>) {
    const kb = new InlineKeyboard();
    q.options.forEach((o, oi) => kb.text(`${set.has(oi) ? "☑" : "☐"} ${o.label.slice(0, 55)}`, `t:${s.shortId}:${qi}:${oi}`).row());
    return kb.text("✅ Done", `d:${s.shortId}:${qi}`).row();
  }

  // ---- outbound ------------------------------------------------------------

  /** pai's sessions in a system turn: no card, no draft; only what it says, if anything. */
  private origins = new Map<string, Origin[]>();
  /** Whether pai's turn in flight is one the user did not start: no card, no draft. */
  private isQuiet(id: string) {
    const head = this.origins.get(id)?.[0];
    return head !== undefined && head !== "user";
  }

  // ---- the message log: pai and its staff ------------------------------------

  /** Event rows wait a moment per chat, so a burst goes out as one folded message. */
  private pendingEvents = new Map<number | null, { items: RichEvent[]; timer: ReturnType<typeof setTimeout> }>();
  private delegationTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private async agentCreated(a: agents.Agent) {
    if (a.kind === "standing" || a.kind === "service") await this.agentTopic(a);
  }

  /** One row of the message log, drawn in the chat it belongs to. */
  private async row(m: LogRow) {
    // A pin is a native venue here; nothing he sent needs drawing back at him.
    if (m.meta.place && m.from !== "user") return void (await this.venue(m));
    const about = agents.get(String(m.meta.agent ?? (m.from !== "user" && m.from !== agents.PAI ? m.from : m.to)));
    const name = (party: string) => agents.get(party)?.name ?? party;
    const first = (text: string) => text.split("\n").find((l) => l.trim())?.trim().slice(0, 300) ?? "";
    switch (m.kind) {
      case "delegate": {
        const target = agents.get(m.to);
        if (!target) return;
        // A sub-agent's delegation is drawn in the chat it runs in; the brief also opens its parent's topic for a standing agent.
        const chat = this.chatOf(m.from);
        const sent = await this.post(chat, `↳ <b>${esc(target.name)}</b>: ${esc(first(m.body))}`, this.meta(target, { kind: "delegation", status: target.status, breadcrumb: agents.breadcrumb(target.slug) }), { silent: true });
        if (sent) agents.setCard(target.slug, sent);
        if (target.threadId !== null && target.threadId !== chat) await this.post(target.threadId, `${esc(name(m.from))}: ${html(m.body.slice(0, 3500))}`, this.meta(target, { kind: "delegation", status: target.status }), { silent: true });
        return;
      }
      case "report": {
        const from = agents.get(m.from);
        if (!from) return;
        // The full report is in the agent's own chat already, as its turn; its parent's chat gets the first line.
        const chat = this.chatOf(m.to);
        if (chat === from.threadId) return;
        await this.post(chat, `↩ <b>${esc(from.name)}</b>: ${esc(first(m.body))}`, this.meta(from, { kind: "report" }), { silent: true });
        return;
      }
      case "ask": {
        if (m.to !== "user") return;
        const askId = Number(m.meta.askId);
        const options = (m.meta.options as string[] | undefined) ?? [];
        const kb = options.reduce((kb, o, i) => kb.text(o.slice(0, 60), `k:${askId}:${i}`).row(), new InlineKeyboard());
        const crumb = String(m.meta.breadcrumb ?? "");
        const text = `${m.meta.priority === "urgent" ? "❗" : "❓"} <i>${esc(crumb)}</i>\n${html(m.body)}${m.meta.freeText === false ? "" : options.length ? "\n\n<i>tap an option or reply with text</i>" : "\n\n<i>reply to this message to answer</i>"}`;
        const sent = await this.post(this.mainThread(), text, this.meta(about, { kind: "ask", askId, options, breadcrumb: crumb, priority: String(m.meta.priority ?? "normal") }), { silent: Boolean(m.meta.silent), keyboard: options.length ? kb : undefined });
        if (sent) kv.set(`ask:${sent}`, String(askId));
        if (sent) kv.set(`askmsg:${askId}`, String(sent));
        return;
      }
      case "notice": {
        const priority = String(m.meta.priority ?? "normal");
        const chat = m.to === "user" ? this.mainThread() : this.chatOf(m.from);
        const crumb = String(m.meta.breadcrumb ?? (about ? agents.breadcrumb(about.slug) : ""));
        await this.post(chat, `${priority === "urgent" ? "🔔" : "🔕"} ${crumb && m.to === "user" ? `<i>${esc(crumb)}</i>\n` : ""}${html(m.body)}`, this.meta(about, { kind: "notice", priority, breadcrumb: crumb }), { silent: priority !== "urgent" });
        return;
      }
      case "request":
      case "response": {
        // Hops between agents show in the asking agent's chat, so its draft, the rewrite and the approval read in order.
        const requester = m.kind === "request" ? m.from : m.to;
        if (requester === agents.PAI || !agents.get(requester)) return;
        const chat = this.chatOf(requester);
        if (chat === this.mainThread()) return;
        const arrow = m.kind === "request" ? `→ asked pai: ${esc(String(m.meta.need ?? first(m.body)))}` : `← ${esc(name(m.from))}: ${html(m.body.slice(0, 3000))}`;
        await this.post(chat, arrow, this.meta(agents.get(requester), { kind: "event", event: m.kind, icon: EVENT_ICONS[m.kind] }), { silent: true });
        return;
      }
      case "event": {
        const event = String(m.meta.event ?? "event");
        // Created, spawned, closed and errors show where the agent's parent works; the rest where the agent does.
        const parentSide = event === "agent.created" || event === "agent.spawned" || event === "agent.closed" || event === "error";
        const chat = parentSide ? this.chatOf(m.to === m.from ? (about?.parent ?? agents.PAI) : m.to) : this.chatOf(about?.slug ?? m.from);
        const source = String(m.meta.source ?? "");
        const icon = EVENT_ICONS[event === "item.arrived" && source && source !== "mail" ? `item.${source}` : event] ?? EVENT_ICONS[event] ?? "circle";
        this.queueEvent(chat, { event, text: m.body.slice(0, 200), icon, agent: about?.slug });
        return;
      }
      default:
        return;
    }
  }

  private queueEvent(chat: number | null, item: RichEvent) {
    const pending = this.pendingEvents.get(chat);
    if (pending) return void pending.items.push(item);
    const entry = { items: [item], timer: setTimeout(() => void this.flushEvents(chat).catch((err) => log.warn("events failed", (err as Error).message)), 20_000) };
    this.pendingEvents.set(chat, entry);
  }

  /** A burst of events as one quiet message: a single row as itself, several folded under a count. */
  private async flushEvents(chat: number | null) {
    const entry = this.pendingEvents.get(chat);
    this.pendingEvents.delete(chat);
    if (!entry?.items.length) return;
    const { items } = entry;
    const glyph = (i: RichEvent) => (i.event === "error" ? "⚠️" : i.event.startsWith("agent.") ? "•" : "·");
    if (items.length === 1) {
      const i = items[0]!;
      await this.post(chat, `${glyph(i)} <i>${esc(i.text)}</i>`, this.meta(i.agent ? agents.get(i.agent) : undefined, { kind: "event", event: i.event, icon: i.icon }), { silent: true });
      return;
    }
    const counts = new Map<string, number>();
    for (const i of items) counts.set(eventNoun(i), (counts.get(eventNoun(i)) ?? 0) + 1);
    const summary = [...counts].map(([noun, n]) => `${n} ${noun}${n === 1 ? "" : "s"}`).join(", ");
    const lines = items.slice(0, 30).map((i) => `${glyph(i)} ${esc(i.text)}`);
    await this.post(chat, `<i>${items.length} events: ${esc(summary)}</i>\n<blockquote expandable>${lines.join("\n")}</blockquote>`, this.meta(undefined, { kind: "events", items: items.slice(0, 30) }), { silent: true });
  }

  /** A delegation card follows its agent's status, a few seconds behind. */
  private scheduleDelegation(a: agents.Agent) {
    if (a.cardId === null || this.delegationTimers.has(a.slug)) return;
    this.delegationTimers.set(
      a.slug,
      setTimeout(() => {
        this.delegationTimers.delete(a.slug);
        const now_ = agents.get(a.slug);
        if (!now_ || now_.cardId === null) return;
        const brief = db.query("SELECT body FROM messages WHERE recipient = ? AND kind = 'delegate' ORDER BY id DESC LIMIT 1").get(a.slug) as { body: string } | undefined;
        const line = brief?.body.split("\n").find((l) => l.trim())?.trim().slice(0, 300) ?? "";
        const status = { working: "working", waiting: "waiting on you", queued: "queued", idle: "done", closed: "closed" }[now_.status] ?? now_.status;
        void this.bot.api
          .editMessageText(this.chatId, now_.cardId, `↳ <b>${esc(now_.name)}</b>: ${esc(line)}\n<i>${status}</i>${this.trailerFor(this.meta(now_, { kind: "delegation", status: now_.status, breadcrumb: agents.breadcrumb(now_.slug) }))}`, { parse_mode: "HTML", link_preview_options: { is_disabled: true } })
          .catch((err: Error) => !err.message.includes("not modified") && log.debug("card edit failed", err.message));
      }, 3000),
    );
  }

  private async askAnswered(a: asks.Ask) {
    const id = kv.get(`askmsg:${a.id}`);
    if (!id) return;
    const answer = a.status === "dropped" ? "withdrawn" : (a.answer ?? "");
    const crumb = agents.breadcrumb(a.agent);
    await this.bot.api
      .editMessageText(this.chatId, Number(id), `✅ <i>${esc(crumb)}</i>\n${html(a.question)}\n\n→ <b>${esc(answer)}</b>${this.trailerFor(this.meta(agents.get(a.agent), { kind: "ask", askId: a.id, options: a.options, breadcrumb: crumb, answer }))}`, { parse_mode: "HTML", link_preview_options: { is_disabled: true } })
      .catch((err: Error) => log.debug("ask edit failed", err.message));
  }

  /** The trailer for a message-log row: whose chat, which topic. */
  private meta(a: agents.Agent | undefined, extra: Partial<RichMeta>): Partial<RichMeta> & { session: string } {
    return { session: a?.slug ?? agents.PAI, agent: a?.slug, agentName: a?.name, thread: a?.threadId ?? undefined, ...extra };
  }

  private trailerFor(meta: Partial<RichMeta> & { session: string }) {
    const base = config.baseUrl;
    if (!base) return "";
    try {
      return ` <a href="${trailerUrl(base, { v: PROTOCOL_VERSION, kind: "event", ...meta } as RichMeta)}">${MARKER}</a>`;
    } catch (err) {
      log.warn(`dropping metadata: ${(err as Error).message}`);
      return "";
    }
  }

  /** Posts one message from the log into a chat; the id of the last chunk comes back. */
  /**
   * A map pin, as Telegram's own venue or location message: a native card he can tap into his
   * maps app. It carries no trailer — a venue has no text to hang one on — so the structure lives
   * on the log row, which is what our own clients draw from anyway.
   */
  private async venue(m: LogRow) {
    const place = m.meta.place!;
    const chat = (m.to === "user" ? this.mainThread() : this.chatOf(m.from)) ?? undefined;
    const where = { message_thread_id: chat };
    if (place.title && place.address) await this.bot.api.sendVenue(this.chatId, place.latitude, place.longitude, place.title, place.address, where);
    else await this.bot.api.sendLocation(this.chatId, place.latitude, place.longitude, where);
  }

  private async post(chat: number | null, htmlText: string, meta: Partial<RichMeta> & { session: string }, opts: { silent?: boolean; keyboard?: InlineKeyboard } = {}) {
    const chunks = splitMessage(htmlText, 3800);
    let last: number | undefined;
    for (const [index, chunk] of chunks.entries()) {
      const final = index === chunks.length - 1;
      const sent = await this.bot.api.sendMessage(this.chatId, final ? chunk.text + this.trailerFor(meta) : chunk.text, {
        parse_mode: "HTML",
        message_thread_id: chat ?? undefined,
        link_preview_options: { is_disabled: true },
        disable_notification: opts.silent,
        reply_markup: final ? opts.keyboard : undefined,
      });
      last = sent.message_id;
    }
    return last;
  }

  /** Per terminal thread, in order: a transcript chunk arrives as a burst of events, and the chat must show them as they happened. */
  private queues = new Map<string, Promise<void>>();

  take(e: PaiEvent) {
    const fail = (err: unknown) => log.warn("relay failed", (err as Error).message);
    if (e.kind === "message.new") return void this.row(e.payload as unknown as LogRow).catch(fail);
    if (e.kind === "agent.created") return void this.agentCreated(e.payload as unknown as agents.Agent).catch(fail);
    if (e.kind === "agent.changed") return void this.scheduleDelegation(e.payload as unknown as agents.Agent);
    if (e.kind === "ask.answered") return void this.askAnswered(e.payload as unknown as asks.Ask).catch(fail);
    if (!e.payload.terminal || !e.sessionId) return void this.relay(e).catch(fail);
    const key = e.sessionId;
    const next = (this.queues.get(key) ?? Promise.resolve()).then(() => this.relay(e)).catch(fail);
    this.queues.set(key, next);
    void next.then(() => this.queues.get(key) === next && this.queues.delete(key));
  }

  async relay(e: PaiEvent) {
    if (e.kind === "rate_limit") {
      const info = e.payload as { status?: string };
      if (info.status === "rejected") await this.send(null, `⛔ rate limited: ${esc(JSON.stringify(info))}`);
      return;
    }
    if (e.kind === "daemon.updated") {
      const info = e.payload as { from?: string; to?: string; at?: string };
      const when = new Date(info.at ?? Date.now()).toLocaleString();
      await this.send(null, `🚀 pai updated <code>${esc(info.from ?? "?")}</code> → <code>${esc(info.to ?? "?")}</code>\n${esc(when)}`);
      return;
    }
    if (!e.sessionId) return;
    const s = findThread(e.sessionId);
    if (!s) return;

    switch (e.kind) {
      case "task.created":
        await this.openTopic(s);
        if (e.payload.adopted) await this.history(s);
        await this.announceChild(s);
        break;
      case "session.ready":
        this.scheduleCard(s);
        break;
      case "session.input":
        // pai thinking about a request or a routine is not something to watch in the one chat.
        if (main.isMain(s.id)) {
          const origin = (e.payload.origin as Origin | undefined) ?? "user";
          this.origins.set(s.id, [...(this.origins.get(s.id) ?? []), origin]);
          if (origin !== "user") break;
        }
        // Typed in a terminal: the chat shows it as the user's own message (Paigram puts it on their side).
        if (e.payload.echo && String(e.payload.text ?? "").trim()) await this.send(s, esc(String(e.payload.text).trim()), s, { kind: "user" });
        // Thinking shows on the status card; the draft starts once there is text to stream.
        this.turnTools.set(s.id, []);
        this.turnStarted.set(s.id, now());
        await this.ensureCard(s);
        break;
      case "session.delta":
        if (!this.isQuiet(s.id)) await this.draft(s, String(e.payload.turn ?? e.payload.text));
        break;
      case "session.tool": {
        const tools = this.turnTools.get(s.id) ?? [];
        if (tools.length < MAX_TRAILER_TOOLS)
          tools.push({ name: String(e.payload.name ?? "tool"), detail: String(e.payload.summary ?? "").slice(0, MAX_TOOL_DETAIL) });
        this.turnTools.set(s.id, tools);
        if (this.isQuiet(s.id)) break;
        // A terminal's turn may have started before the chat was following it, or said something in between: the card goes below.
        if (e.payload.terminal && s.cardId === null) {
          if (!this.turnStarted.has(s.id)) this.turnStarted.set(s.id, now());
          await this.ensureCard(s);
        }
        this.scheduleCard(s);
        break;
      }
      case "session.text": {
        // A terminal's turn says things between its tool calls; each lands as it is said, with the tools before it.
        if (!e.payload.flush) break;
        const text = String(e.payload.text ?? "").trim();
        if (!text) break;
        await this.dropCard(s);
        await this.send(s, html(text), s, { tools: this.turnTools.get(s.id) ?? [] });
        this.turnTools.set(s.id, []);
        break;
      }
      case "session.progress":
        await this.send(s, esc(String(e.payload.text)), s);
        break;
      case "session.turn_end": {
        this.endDraft(s);
        const text = String(e.payload.text ?? "").trim();
        const quiet = main.isMain(s.id) ? this.origins.get(s.id)?.shift() : undefined;
        if (quiet && quiet !== "user") {
          if (text && quiet === "system") await this.send(s, html(text), s, { tools: this.turnTools.get(s.id) ?? [] });
          this.turnTools.delete(s.id);
          this.turnStarted.delete(s.id);
          break;
        }
        const tools = this.turnTools.get(s.id) ?? [];
        const durationMs = Number(e.payload.durationMs ?? 0) || now() - (this.turnStarted.get(s.id) ?? now());
        this.turnTools.delete(s.id);
        this.turnStarted.delete(s.id);
        if (text) {
          await this.send(s, html(text), s, { tools, durationMs });
          await this.dropCard(s);
        } else {
          // Nothing to say: the card stays as the record of the turn, and the next turn gets a card of its own.
          await this.updateCard(s, { tools, durationMs });
          s.cardId = null;
          s.persist();
        }
        break;
      }
      case "session.question":
        await this.askUser(s, e.payload.questions as Question[]);
        this.scheduleCard(s);
        break;
      case "session.answer":
        this.scheduleCard(s);
        break;
      case "session.error":
        this.endDraft(s);
        await this.send(s, `🔴 ${esc(String(e.payload.message))}`, s);
        await this.dropCard(s);
        break;
      case "session.exit":
        this.endDraft(s);
        if (e.payload.code !== 0) await this.send(s, `⚪ session ended (code ${e.payload.code})`, s);
        await this.dropCard(s);
        break;
    }
  }

  /** A task gets a topic of its own when the bot has topics enabled; otherwise it shares the root chat. */
  private async openTopic(s: Thread) {
    // pai's and its agents' sessions live in their agent's chat, never a topic of their own.
    const slug = "agent" in s ? s.agent : null;
    if (slug && s.threadId === null && this.topics) {
      const a = agents.get(slug);
      const thread = !a || a.kind === "orchestrator" ? this.mainThread() : a.kind === "sub" ? this.chatOf(a.parent ?? agents.PAI) : await this.agentTopic(a);
      s.threadId = thread;
      s.persist();
      return;
    }
    if (slug) return;
    if (s.threadId === null && this.topics) {
      try {
        const topic = await this.bot.api.createForumTopic(this.chatId, s.title.slice(0, 128));
        s.threadId = topic.message_thread_id;
        s.persist();
      } catch (err) {
        log.warn("createForumTopic failed", (err as Error).message);
      }
    }
  }

  /** The turn's status line, posted after the message that started it; edited as tools run, removed once the answer lands. */
  private async ensureCard(s: Thread) {
    if (s.threadId === null || s.cardId !== null) return;
    const sent = await this.bot.api.sendMessage(this.chatId, this.cardText(s), {
      parse_mode: "HTML",
      message_thread_id: s.threadId,
      link_preview_options: { is_disabled: true },
    });
    s.cardId = sent.message_id;
    s.persist();
  }

  private async dropCard(s: Thread) {
    const id = s.cardId;
    if (id === null) return;
    s.cardId = null;
    s.persist();
    const timer = this.cardTimers.get(s.id);
    if (timer) clearTimeout(timer);
    this.cardTimers.delete(s.id);
    await this.bot.api.deleteMessage(this.chatId, id).catch((err: Error) => log.debug("card delete failed", err.message));
  }

  /** A conversation adopted from disk opens with its recent exchanges, so the topic is not empty. */
  private async history(s: Thread) {
    if (s.threadId === null) return;
    const recent = (await transcript(s.id, s.cwd, 400).catch(() => [])).filter((m) => !m.meta && m.text.trim()).slice(-HISTORY_MESSAGES);
    for (const m of recent) {
      if (m.role === "user") await this.send(s, esc(m.text.trim().slice(0, 3000)), s, { kind: "user" });
      else {
        const tools = (m.tools ?? []).slice(0, MAX_TRAILER_TOOLS).map((t): RichTool => ({ name: t.name, detail: (t.input ?? "").slice(0, MAX_TOOL_DETAIL) }));
        await this.send(s, html(m.text.trim()), s, { tools });
      }
    }
  }

  /** A task another session started shows up in that session's topic, so the user can follow it from there. */
  private async announceChild(s: Thread) {
    const parent = s.parent ? sessions.find(s.parent) : undefined;
    if (!parent || parent.threadId === null || parent.threadId === s.threadId) return;
    await this.send(parent, `↳ started ${this.tag(s)}`, parent);
  }

  private tag(s: Thread) {
    const base = config.baseUrl;
    const id = base ? `<a href="${base}/app/?s=${s.shortId}">${s.shortId}</a>` : s.shortId;
    return `[${esc(s.title)} · ${id}]`;
  }

  /**
   * Metadata for a client that knows how to render it. Stock Telegram shows the trailing
   * link and nothing else, so this is only attached when there is a URL to point at.
   */
  private trailer(s: Thread | null, extra: Partial<RichMeta> = {}) {
    const base = config.baseUrl;
    if (!s || !base) return "";
    const meta: RichMeta = {
      v: PROTOCOL_VERSION,
      kind: s.threadId === this.mainThread() ? "turn" : "result",
      session: s.shortId,
      project: s.project,
      ...extra,
    };
    try {
      return ` <a href="${trailerUrl(base, meta)}">${MARKER}</a>`;
    } catch (err) {
      log.warn(`dropping metadata: ${(err as Error).message}`);
      return "";
    }
  }

  /** Sends HTML text into a session's place in the chat, chunked, and remembers which session it came from. */
  private async send(s: Thread | null, htmlText: string, linkTo?: Thread, meta: Partial<RichMeta> = {}) {
    const threadId = s?.threadId ?? undefined;
    const prefix = s && threadId === undefined ? `${this.tag(s)}\n` : "";
    const chunks = splitMessage(prefix + htmlText, 4000);
    for (const [index, chunk] of chunks.entries()) {
      const text = index === chunks.length - 1 ? chunk.text + this.trailer(s, meta) : chunk.text;
      const sent = await this.bot.api.sendMessage(this.chatId, text, {
        parse_mode: "HTML",
        message_thread_id: threadId,
        link_preview_options: { is_disabled: true },
      });
      if (linkTo)
        db.prepare("INSERT OR REPLACE INTO tg_messages (message_id, session_id, ts) VALUES (?, ?, ?)").run(
          sent.message_id,
          linkTo.id,
          now(),
        );
    }
  }

  /** Streams the turn's text as a Telegram draft: animated in place, no edit spam. */
  private async draft(s: Thread, text: string) {
    let box = this.outboxes.get(s.id);
    if (!box) {
      box = { draftId: (now() % 2_000_000_000) + 1, lastText: "", lastSent: 0 };
      this.outboxes.set(s.id, box);
      // Drafts expire after ~30s; while a long tool call runs, keep the placeholder alive.
      box.keepalive = setInterval(() => void this.pushDraft(s, box!, box!.lastText), 20_000);
    }
    box.lastText = text;
    const due = 700 - (now() - box.lastSent);
    if (due <= 0) await this.pushDraft(s, box, text);
    else if (!box.timer) box.timer = setTimeout(() => void this.pushDraft(s, box!, box!.lastText), due);
  }

  private async pushDraft(s: Thread, box: Outbox, text: string) {
    box.timer = undefined;
    box.lastSent = now();
    await this.bot.api
      .sendMessageDraft(this.chatId, box.draftId, text.slice(-4000), { message_thread_id: s.threadId ?? undefined })
      .catch((err: Error) => log.debug("draft failed", err.message));
  }

  private endDraft(s: Thread) {
    const box = this.outboxes.get(s.id);
    if (!box) return;
    clearTimeout(box.timer);
    clearInterval(box.keepalive);
    this.outboxes.delete(s.id);
  }

  private async askUser(s: Thread, questions: Question[]) {
    for (const [qi, q] of questions.entries()) {
      const kb = q.multiSelect
        ? this.multiKeyboard(s, q, qi, new Set())
        : q.options.reduce((kb, o, oi) => kb.text(o.label.slice(0, 60), `a:${s.shortId}:${qi}:${oi}`).row(), new InlineKeyboard());
      const sent = await this.bot.api.sendMessage(this.chatId, questionText(q), {
        parse_mode: "HTML",
        message_thread_id: s.threadId ?? undefined,
        reply_markup: kb,
      });
      db.prepare("INSERT OR REPLACE INTO tg_messages (message_id, session_id, ts) VALUES (?, ?, ?)").run(sent.message_id, s.id, now());
    }
  }

  // ---- live card -----------------------------------------------------------

  private scheduleCard(s: Thread) {
    if (s.threadId === null) return;
    if (this.cardTimers.has(s.id)) return;
    this.cardTimers.set(
      s.id,
      setTimeout(() => {
        this.cardTimers.delete(s.id);
        void this.updateCard(s);
      }, 1500),
    );
  }

  private status(s: Thread): keyof typeof STATUS {
    if (s.pending) return "waiting";
    // A process coming up with nothing to answer (a revived or adopted conversation) is not thinking.
    if (s.state === "starting" && !this.turnStarted.has(s.id)) return "idle";
    return s.state;
  }

  private cardText(s: Thread, done?: { tools: RichTool[]; durationMs: number }) {
    const st = done ? "idle" : this.status(s);
    const age = Math.max(1, Math.round((now() - startedAt(s)) / 60_000));
    const meta = [s.kind === "code" ? `code · ${esc(s.project ?? "")}` : "task", `${s.turns} turn${s.turns === 1 ? "" : "s"}`, `$${s.costUsd.toFixed(2)}`, `${age}m`];
    const lines = [`${STATUS[st]} <b>${esc(s.title)}</b> <code>${s.shortId}</code>`, meta.join(" · ")];
    if (st === "busy") for (const t of s.recentTools) lines.push(`⚙ ${esc(t.slice(0, 100))}`);
    if (st === "waiting") lines.push("❓ waiting for your answer");
    if (config.baseUrl) lines.push(`<a href="${config.baseUrl}/app/?s=${s.shortId}">details</a>`);
    const tools = done?.tools ?? this.turnTools.get(s.id) ?? [];
    const tool = done ? undefined : tools.at(-1)?.detail || s.recentTools.at(-1);
    return lines.join("\n") + this.trailer(s, { kind: "status", state: st, tool, tools, startedAt: done ? undefined : this.turnStarted.get(s.id), durationMs: done?.durationMs });
  }

  private async updateCard(s: Thread, done?: { tools: RichTool[]; durationMs: number }) {
    if (s.threadId === null) return;
    if (s.cardId !== null)
      await this.bot.api
        .editMessageText(this.chatId, s.cardId, this.cardText(s, done), { parse_mode: "HTML", link_preview_options: { is_disabled: true } })
        .catch((err: Error) => {
          if (!err.message.includes("not modified")) log.debug("card edit failed", err.message);
        });
    // Status lives on the card only: renaming the topic posts a service message every time.
  }
}

function startedAt(s: Thread): number {
  const row = db.query("SELECT started_at FROM sessions WHERE session_id = ?").get(s.id) as { started_at: number } | undefined;
  return row?.started_at ?? now();
}

type Origin = "user" | "system" | "silent";

const AGENT_STATUS: Record<string, string> = { idle: "🟢", queued: "🔵", working: "🔵", waiting: "🟡", closed: "⚪" };

/** What a folded run counts an event as: "2 routines, 3 emails". */
function eventNoun(i: RichEvent) {
  switch (i.event) {
    case "routine.fired":
      return "routine";
    case "item.arrived":
      return i.icon === "envelope" ? "email" : "message";
    case "calendar.upcoming":
      return "meeting";
    case "agent.woken":
      return "wake-up";
    case "error":
      return "error";
    default:
      return "update";
  }
}

function questionText(q: Question) {
  const opts = q.options.map((o, i) => `${i + 1}. <b>${esc(o.label)}</b>${o.description ? ` — ${esc(o.description)}` : ""}`);
  const hint = q.multiSelect ? "tap to toggle options, then Done" : "tap an option or reply with text";
  return `❓ <b>${esc(q.header)}</b>\n${esc(q.question)}\n\n${opts.join("\n")}\n\n<i>${hint}</i>`;
}

/** A client may open a thread in a project by starting its first message with `/project <slug>`. */
export function projectPrefix(text: string): { project?: string; text: string } {
  const m = /^\/project\s+([A-Za-z0-9._-]+)\s*\n?/.exec(text);
  return m ? { project: m[1], text: text.slice(m[0].length) } : { text };
}

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Model output is markdown; Telegram wants its HTML subset. */
function html(markdown: string) {
  try {
    return markdownToTelegramHtml(markdown);
  } catch {
    return esc(markdown);
  }
}

export { InputFile };
