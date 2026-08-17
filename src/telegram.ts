import { Bot } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import { config } from "./config.ts";
import { db, now } from "./db.ts";
import { bus, type BuilderEvent } from "./bus.ts";
import { chat } from "./agent.ts";
import { clear } from "./chat.ts";
import { logger } from "./log.ts";

const log = logger("telegram");

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
  const send = (text: string) => bot.api.sendMessage(chatId, clip(text));

  bot.on("message:text", async (ctx) => {
    if (ctx.chat.id !== chatId) return;
    const text = ctx.message.text;

    if (text === "/reset") {
      clear();
      return void ctx.reply("history cleared");
    }

    // Turns can take a while — keep the typing indicator alive until the reply lands.
    const typing = setInterval(() => void ctx.replyWithChatAction("typing").catch(() => {}), 5000);
    void ctx.replyWithChatAction("typing").catch(() => {});

    try {
      const replyTo = ctx.message.reply_to_message?.message_id;
      const linked = replyTo
        ? (db.query("SELECT session_id FROM tg_messages WHERE message_id = ?").get(replyTo) as
            | { session_id: string }
            | undefined)
        : undefined;
      // A Telegram reply is an explicit pointer at a session; hand it to the agent as context.
      const prompt = linked ? `(replying to session ${linked.session_id.slice(0, 6)})\n${text}` : text;

      const result = await chat(prompt);
      await ctx.reply(clip(result.text));
    } catch (err) {
      log.error("turn failed", err);
      await ctx.reply(`error: ${(err as Error).message}`);
    } finally {
      clearInterval(typing);
    }
  });

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

/** Session activity goes to the chat and into the agent's memory of the conversation. */
async function relay(e: BuilderEvent, send: (text: string) => Promise<{ message_id: number }>) {
  const short = e.sessionId?.slice(0, 6) ?? "";
  const tag = e.sessionId ? `${e.project} · ${short}` : "builder";
  try {
    if (e.kind === "session.turn_end") {
      const text = String(e.payload.text ?? "").trim();
      if (!text) return;
      const sent = await send(`[${tag}]\n${text}`);
      if (e.sessionId) link(sent.message_id, e.sessionId);
    } else if (e.kind === "session.exit" && e.payload.code !== 0) {
      await send(`[${tag}] session exited (code ${e.payload.code})`);
    } else if (e.kind === "rate_limit" && e.payload.status !== "allowed") {
      await send(`rate limit: ${e.payload.status}`);
    }
  } catch (err) {
    log.warn("relay failed", (err as Error).message);
  }
}

function clip(s: string, max = 4000) {
  return s.length <= max ? s : `${s.slice(0, max - 20)}\n… (truncated)`;
}
