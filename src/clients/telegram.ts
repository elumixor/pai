import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import { markdownToTelegramHtml, splitMessage } from "@elumixor/react-telegram";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "../core/config.ts";
import { db, kv, now } from "../core/db.ts";
import { bus, type PaiEvent } from "../core/bus.ts";
import * as sessions from "../domain/sessions.ts";
import type { Question, Session } from "../domain/session.ts";
import { logger } from "../core/log.ts";
import { transcribe } from "../domain/transcribe.ts";
import { MARKER, PROTOCOL_VERSION, trailerUrl, type RichMeta } from "../protocol/rich.ts";

const log = logger("telegram");

const MAIN_THREAD = "main_thread_id";
const STATUS = { starting: "🔵", busy: "🔵", idle: "🟢", waiting: "🟡", dead: "⚪", error: "🔴" } as const;
const INBOX = join(config.workspace, "inbox");

export function startTelegram() {
  if (!config.telegram.enabled) return undefined;
  if (!config.telegram.token || !config.telegram.chatId) {
    log.warn("telegram disabled: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set");
    return undefined;
  }
  mkdirSync(INBOX, { recursive: true });

  const bot = new Bot(config.telegram.token);
  bot.api.config.use(apiThrottler());
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3 }));
  const chatId = config.telegram.chatId;
  const tg = new Frontend(bot, chatId);

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

  bus.on("event", (e: PaiEvent) => void tg.relay(e).catch((err) => log.warn("relay failed", (err as Error).message)));

  bot.catch((err) => log.error("bot error", err.message));
  void (async () => {
    const me = await bot.api.getMe();
    tg.topics = Boolean(me.has_topics_enabled) || Boolean(kv.get(MAIN_THREAD));
    log.info(`@${me.username}, topics ${tg.topics ? "on" : "off (enable in @BotFather → Bot Settings → Threads Settings)"}`);
    if (tg.topics) await tg.ensureMainTopic();
    await bot.api.setMyCommands([
      { command: "new", description: "start a task in a new topic: /new <title>" },
      { command: "tasks", description: "what is running" },
      { command: "stop", description: "interrupt this session" },
      { command: "reset", description: "forget the main conversation" },
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
  return bot;
}

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

class Frontend {
  topics = false;
  private outboxes = new Map<string, Outbox>();
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
    const text = msg.text ?? msg.caption ?? "";

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

    void ctx.api.setMessageReaction(this.chatId, msg.message_id, [{ type: "emoji", emoji: "👀" }]).catch(() => {});

    const session = this.route(ctx, threadId);
    const images = await this.attachments(ctx);
    const body = images.note ? `${text}\n\n${images.note}`.trim() : text;
    if (!body && images.images.length === 0) return;

    if (session.pending) {
      session.answer(body);
      return;
    }
    session.send(body, { images: images.images });
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
      await this.bot.api.sendMessage(this.chatId, "This is the main conversation. Other topics are tasks; typing a new thread starts one.", {
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

  private main(): Session {
    const m = sessions.main();
    const thread = this.mainThread();
    if (thread !== null && m.threadId !== thread) {
      m.threadId = thread;
      m.persist();
    }
    return m;
  }

  /** Which session a message belongs to: its topic, the message it replies to, or the main conversation. */
  private route(ctx: Context, threadId: number | null): Session {
    if (threadId !== null && threadId === this.mainThread()) return this.main();
    if (threadId !== null) {
      const existing = sessions.byThread(threadId);
      if (existing) return existing;
      const created = ctx.message?.reply_to_message?.forum_topic_created;
      const text = ctx.message?.text ?? ctx.message?.caption ?? "";
      const name = created && !created.is_name_implicit ? created.name : text.replace(/\s+/g, " ").slice(0, 40) || `topic ${threadId}`;
      return sessions.spawnTask({ title: name, threadId });
    }
    const replyTo = ctx.message?.reply_to_message?.message_id;
    if (replyTo) {
      const linked = db.query("SELECT session_id FROM tg_messages WHERE message_id = ?").get(replyTo) as
        | { session_id: string }
        | undefined;
      const s = linked ? sessions.ensureLive(linked.session_id) : undefined;
      if (s) return s;
    }
    return this.main();
  }

  private async command(ctx: Context, text: string, threadId: number | null): Promise<boolean> {
    const [cmd, ...rest] = text.split(/\s+/);
    const arg = rest.join(" ").trim();
    const reply = (t: string) => ctx.reply(t, { parse_mode: "HTML", message_thread_id: threadId ?? undefined });
    switch (cmd?.replace(/@\w+$/, "")) {
      case "/start":
        await reply("pai here. Talk to me here; long work goes into topics. /new &lt;title&gt; starts one by hand.");
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
        const s = threadId !== null && threadId !== this.mainThread() ? sessions.byThread(threadId) : this.main();
        const did = await s?.interrupt();
        await reply(did ? "interrupted" : "nothing running");
        return true;
      }
      case "/reset": {
        sessions.resetMain();
        await reply("main conversation forgotten");
        return true;
      }
      default:
        return false; // unknown slash text goes to the model like anything else
    }
  }

  /** Saves photos/documents/voice notes to the inbox; photos go to the model inline, voice gets transcribed. */
  private async attachments(ctx: Context) {
    const msg = ctx.message!;
    const images: { media_type: string; data: string }[] = [];
    const notes: string[] = [];
    const photo = msg.photo?.at(-1);
    const doc = msg.document;
    const voice = msg.voice ?? msg.audio;
    const fileMeta = photo ?? doc ?? voice;
    if (!fileMeta) return { images, note: "" };
    const file = await ctx.api.getFile(fileMeta.file_id);
    const name = doc?.file_name ?? (voice ? `voice-${now()}.ogg` : `${photo ? "photo" : "file"}-${now()}${photo ? ".jpg" : ""}`);
    const path = join(INBOX, name.replace(/[^\w.-]+/g, "_"));
    const res = await fetch(`https://api.telegram.org/file/bot${config.telegram.token}/${file.file_path}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    await Bun.write(path, bytes);

    if (voice) {
      try {
        const text = await transcribe(path);
        notes.push(text ? `[voice message: "${text}"]` : "[voice message: nothing recognized]");
      } catch (err) {
        log.warn("transcribe failed", (err as Error).message);
        notes.push(`[voice message saved: ${path} — transcription failed]`);
      }
      return { images, note: notes.join("\n") };
    }

    notes.push(`[attachment saved: ${path}]`);
    const mime = doc?.mime_type ?? "image/jpeg";
    if (photo || mime.startsWith("image/")) images.push({ media_type: mime, data: Buffer.from(bytes).toString("base64") });
    return { images, note: notes.join("\n") };
  }

  async callback(ctx: Context) {
    const data = ctx.callbackQuery!.data!;
    const [kind, short, qiStr, oiStr] = data.split(":");
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

  private multiKeyboard(s: Session, q: Question, qi: number, set: Set<number>) {
    const kb = new InlineKeyboard();
    q.options.forEach((o, oi) => kb.text(`${set.has(oi) ? "☑" : "☐"} ${o.label.slice(0, 55)}`, `t:${s.shortId}:${qi}:${oi}`).row());
    return kb.text("✅ Done", `d:${s.shortId}:${qi}`).row();
  }

  // ---- outbound ------------------------------------------------------------

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
    const s = sessions.find(e.sessionId);
    if (!s) return;

    switch (e.kind) {
      case "task.created":
        await this.openTopic(s);
        break;
      case "session.input":
        await this.draft(s, "");
        this.scheduleCard(s);
        break;
      case "session.delta":
        await this.draft(s, String(e.payload.text));
        break;
      case "session.tool":
        this.scheduleCard(s);
        break;
      case "session.progress":
        await this.send(s, esc(String(e.payload.text)), s);
        break;
      case "session.turn_end": {
        this.endDraft(s);
        const text = String(e.payload.text ?? "").trim();
        if (text) await this.send(s, html(text), s);
        this.scheduleCard(s);
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
        this.scheduleCard(s);
        break;
      case "session.exit":
        this.endDraft(s);
        if (e.payload.code !== 0) await this.send(s, `⚪ session ended (code ${e.payload.code})`, s);
        this.scheduleCard(s);
        break;
    }
  }

  /** A task gets a topic of its own when the bot has topics enabled; otherwise it shares the root chat. */
  private async openTopic(s: Session) {
    if (s.threadId === null && this.topics) {
      try {
        const topic = await this.bot.api.createForumTopic(this.chatId, s.title.slice(0, 128));
        s.threadId = topic.message_thread_id;
        s.persist();
      } catch (err) {
        log.warn("createForumTopic failed", (err as Error).message);
      }
    }
    if (s.threadId !== null) {
      const sent = await this.bot.api.sendMessage(this.chatId, this.cardText(s), {
        parse_mode: "HTML",
        message_thread_id: s.threadId,
        link_preview_options: { is_disabled: true },
      });
      s.cardId = sent.message_id;
      s.persist();
    }
  }

  private tag(s: Session) {
    const url = config.dashboard.url;
    const id = url ? `<a href="${url}/?s=${s.shortId}">${s.shortId}</a>` : s.shortId;
    return `[${esc(s.title)} · ${id}]`;
  }

  /**
   * Metadata for a client that knows how to render it. Stock Telegram shows the trailing
   * link and nothing else, so this is only attached when there is a URL to point at.
   */
  private trailer(s: Session | null) {
    const base = config.dashboard.url;
    if (!s || !base) return "";
    const meta: RichMeta = {
      v: PROTOCOL_VERSION,
      kind: s.kind === "main" ? "turn" : "result",
      session: s.shortId,
      project: s.project,
    };
    try {
      return ` <a href="${trailerUrl(base, meta)}">${MARKER}</a>`;
    } catch (err) {
      log.warn(`dropping metadata: ${(err as Error).message}`);
      return "";
    }
  }

  /** Sends HTML text into a session's place in the chat, chunked, and remembers which session it came from. */
  private async send(s: Session | null, htmlText: string, linkTo?: Session) {
    const threadId = s?.threadId ?? undefined;
    const prefix = s && s.kind !== "main" && threadId === undefined ? `${this.tag(s)}\n` : "";
    const chunks = splitMessage(prefix + htmlText, 4000);
    for (const [index, chunk] of chunks.entries()) {
      const text = index === chunks.length - 1 ? chunk.text + this.trailer(s) : chunk.text;
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

  /** Streams the turn's text as a Telegram draft: animated in place, no edit spam. Empty text shows "Thinking…". */
  private async draft(s: Session, text: string) {
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

  private async pushDraft(s: Session, box: Outbox, text: string) {
    box.timer = undefined;
    box.lastSent = now();
    await this.bot.api
      .sendMessageDraft(this.chatId, box.draftId, text.slice(-4000), { message_thread_id: s.threadId ?? undefined })
      .catch((err: Error) => log.debug("draft failed", err.message));
  }

  private endDraft(s: Session) {
    const box = this.outboxes.get(s.id);
    if (!box) return;
    clearTimeout(box.timer);
    clearInterval(box.keepalive);
    this.outboxes.delete(s.id);
  }

  private async askUser(s: Session, questions: Question[]) {
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

  private scheduleCard(s: Session) {
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

  private status(s: Session): keyof typeof STATUS {
    if (s.pending) return "waiting";
    return s.state;
  }

  private cardText(s: Session) {
    const st = this.status(s);
    const age = Math.max(1, Math.round((now() - startedAt(s)) / 60_000));
    const meta = [s.kind === "code" ? `code · ${esc(s.project ?? "")}` : "task", `${s.turns} turn${s.turns === 1 ? "" : "s"}`, `$${s.costUsd.toFixed(2)}`, `${age}m`];
    const lines = [`${STATUS[st]} <b>${esc(s.title)}</b> <code>${s.shortId}</code>`, meta.join(" · ")];
    if (s.lastTool && st === "busy") lines.push(`⚙ ${esc(s.lastTool.slice(0, 100))}`);
    if (st === "waiting") lines.push("❓ waiting for your answer");
    if (config.dashboard.url) lines.push(`<a href="${config.dashboard.url}/?s=${s.shortId}">details</a>`);
    return lines.join("\n");
  }

  private async updateCard(s: Session) {
    if (s.threadId === null) return;
    if (s.cardId !== null)
      await this.bot.api
        .editMessageText(this.chatId, s.cardId, this.cardText(s), { parse_mode: "HTML", link_preview_options: { is_disabled: true } })
        .catch((err: Error) => {
          if (!err.message.includes("not modified")) log.debug("card edit failed", err.message);
        });
    // Status lives on the card only: renaming the topic posts a service message every time.
  }
}

function startedAt(s: Session): number {
  const row = db.query("SELECT started_at FROM sessions WHERE session_id = ?").get(s.id) as { started_at: number } | undefined;
  return row?.started_at ?? now();
}

function questionText(q: Question) {
  const opts = q.options.map((o, i) => `${i + 1}. <b>${esc(o.label)}</b>${o.description ? ` — ${esc(o.description)}` : ""}`);
  const hint = q.multiSelect ? "tap to toggle options, then Done" : "tap an option or reply with text";
  return `❓ <b>${esc(q.header)}</b>\n${esc(q.question)}\n\n${opts.join("\n")}\n\n<i>${hint}</i>`;
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
