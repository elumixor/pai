import { Bot, InlineKeyboard } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import { config } from "./config.ts";
import { db, now } from "./db.ts";
import { bus, type BuilderEvent } from "./bus.ts";
import { handle, dispatch } from "./handler.ts";
import { find, listAll, recentByProject } from "./sessions.ts";
import { all as allProjects, refresh } from "./catalog.ts";
import { logger } from "./log.ts";

const log = logger("telegram");

/** Pending "which project?" choices, keyed by a short token that fits in callback_data. */
const pending = new Map<string, { text: string; options: { label: string; project: string; sessionId?: string }[] }>();

export function startTelegram() {
  if (!config.telegram.enabled) return undefined;
  if (!config.telegram.token || !config.telegram.chatId) {
    log.warn("telegram disabled: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set");
    return undefined;
  }

  const bot = new Bot(config.telegram.token);
  bot.api.config.use(apiThrottler());
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3 }));

  const chatId = config.telegram.chatId;
  const send = async (text: string, extra: Record<string, unknown> = {}) =>
    bot.api.sendMessage(chatId, clip(text), { parse_mode: "HTML", ...extra });

  bot.on("message:text", async (ctx) => {
    if (ctx.chat.id !== chatId) return;
    const text = ctx.message.text;

    if (text.startsWith("/")) return command(ctx, text, send);

    const replyId = ctx.message.reply_to_message?.message_id;
    const replyTo = replyId
      ? (db.query("SELECT session_id FROM tg_messages WHERE message_id = ?").get(replyId) as
          | { session_id: string }
          | undefined)
      : undefined;

    const result = await handle({ text, replyToSessionId: replyTo?.session_id });

    if (result.kind === "ask") {
      const token = Math.random().toString(36).slice(2, 8);
      pending.set(token, { text, options: result.options ?? [] });
      const kb = new InlineKeyboard();
      (result.options ?? []).forEach((o, i) => kb.text(o.label, `p:${token}:${i}`).row());
      await ctx.reply(escape(result.text), { reply_markup: kb });
      return;
    }

    const sent = await ctx.reply(escape(result.text));
    if (result.sessionId) link(sent.message_id, result.sessionId);
  });

  bot.on("callback_query:data", async (ctx) => {
    const [, token, idxRaw] = ctx.callbackQuery.data.split(":");
    const entry = token ? pending.get(token) : undefined;
    const option = entry?.options[Number(idxRaw)];
    await ctx.answerCallbackQuery();
    if (!entry || !option) return void ctx.editMessageText("expired — send it again");
    pending.delete(token!);
    const result = dispatch(entry.text, option.project, option.sessionId);
    await ctx.editMessageText(escape(result.text));
    if (result.sessionId && ctx.callbackQuery.message) link(ctx.callbackQuery.message.message_id, result.sessionId);
  });

  // Push session activity into the chat.
  bus.on("event", (e: BuilderEvent) => void relay(e, send));

  bot.catch((err) => log.error("bot error", err.message));
  void bot.start({ drop_pending_updates: true, onStart: () => log.info("telegram polling") });
  return bot;
}

function link(messageId: number, sessionId: string) {
  db.prepare("INSERT OR REPLACE INTO tg_messages (message_id, session_id, ts) VALUES (?, ?, ?)").run(
    messageId,
    sessionId,
    now(),
  );
}

async function relay(e: BuilderEvent, send: (text: string, extra?: Record<string, unknown>) => Promise<any>) {
  const tag = e.sessionId ? `${e.project} · ${e.sessionId.slice(0, 6)}` : "builder";
  try {
    if (e.kind === "session.turn_end") {
      const text = String(e.payload.text ?? "").trim();
      const sent = await send(`<b>${escape(tag)}</b>\n${escape(text)}`);
      if (e.sessionId) link(sent.message_id, e.sessionId);
    } else if (e.kind === "session.exit" && e.payload.code !== 0) {
      await send(`<b>${escape(tag)}</b> exited (code ${e.payload.code})`);
    } else if (e.kind === "rate_limit" && e.payload.status !== "allowed") {
      await send(`⚠️ rate limit: ${escape(String(e.payload.status))}`);
    }
  } catch (err) {
    log.warn("relay failed", (err as Error).message);
  }
}

async function command(ctx: any, text: string, send: (t: string, e?: Record<string, unknown>) => Promise<any>) {
  const [cmd, ...rest] = text.slice(1).split(/\s+/);
  const arg = rest.join(" ");
  switch (cmd) {
    case "ps": {
      const { owned, foreign } = await listAll();
      const mine = owned.length
        ? owned.map((s) => `• ${s.project} · ${s.shortId} — ${s.state}`).join("\n")
        : "(no builder sessions)";
      const others = foreign.map((f: any) => `• ${String(f.cwd).split("/").pop()} — ${f.kind}`).join("\n");
      return send(`<b>builder</b>\n${escape(mine)}\n\n<b>other sessions</b>\n${escape(others || "(none)")}`);
    }
    case "projects":
      return send(escape(allProjects().map((p) => p.slug).join("\n")));
    case "refresh":
      return send(`indexed ${refresh().length} projects`);
    case "kill": {
      const s = find(arg);
      if (!s) return send("no such session");
      s.kill();
      return send(`killed ${s.shortId}`);
    }
    case "recent":
      return send(
        escape(
          recentByProject(undefined, 10)
            .map((s) => `${s.project} · ${s.shortId} — ${s.state}`)
            .join("\n") || "(none)",
        ),
      );
    default:
      return send("commands: /ps /recent /projects /refresh /kill &lt;id&gt;");
  }
}

function escape(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function clip(s: string, max = 4000) {
  return s.length <= max ? s : `${s.slice(0, max - 20)}\n… (truncated)`;
}
