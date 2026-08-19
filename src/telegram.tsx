import { Bot, type Context } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import { Message, useFinishRender } from "@elumixor/react-message-renderer";
import { TelegramRenderer } from "@elumixor/react-telegram";
import { useEffect, useState, Fragment } from "react";
import { config } from "./config.ts";
import { db, now } from "./db.ts";
import { bus, type BuilderEvent } from "./bus.ts";
import { chatStream } from "./agent.ts";
import { clear } from "./chat.ts";
import { logger } from "./log.ts";

const log = logger("telegram");

const SESSION_TAG = /\[([^\[\]·]+) · ([0-9a-f]{6})\]/g;

/** `[project · shortId]` tags become links into the dashboard, if one is configured. */
function linkifySessions(text: string) {
  const url = config.dashboard.url;
  if (!url) return text;
  const parts: (string | ReturnType<typeof Fragment>)[] = [];
  let last = 0;
  for (const m of text.matchAll(SESSION_TAG)) {
    const start = m.index ?? 0;
    parts.push(text.slice(last, start));
    const [, project, shortId] = m;
    parts.push(
      <Fragment key={start}>
        [{project} · <a href={`${url}/?s=${shortId}`}>{shortId}</a>]
      </Fragment>,
    );
    last = start + m[0].length;
  }
  parts.push(text.slice(last));
  return parts;
}

function AgentReply({ prompt, onDone }: { prompt: string; onDone: (text: string) => void }) {
  const [text, setText] = useState("…");
  const finish = useFinishRender();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await chatStream(prompt, (partial) => !cancelled && setText(partial || "…"));
      if (cancelled) return;
      setText(result.text);
      onDone(result.text);
      void finish();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <Message>{linkifySessions(text)}</Message>;
}

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
  const send = (text: string) => bot.api.sendMessage(chatId, clip(text), { parse_mode: "HTML" });

  bot.on("message:text", async (ctx: Context) => {
    if (!ctx.chat || ctx.chat.id !== chatId || !ctx.message) return;
    const text = ctx.message.text ?? "";

    void ctx.api.setMessageReaction(chatId, ctx.message.message_id, [{ type: "emoji", emoji: "👀" }]).catch(() => {});

    if (text === "/reset") {
      clear();
      return void ctx.reply("history cleared");
    }

    try {
      const replyTo = ctx.message.reply_to_message?.message_id;
      const linked = replyTo
        ? (db.query("SELECT session_id FROM tg_messages WHERE message_id = ?").get(replyTo) as
            | { session_id: string }
            | undefined)
        : undefined;
      // A Telegram reply is an explicit pointer at a session; hand it to the agent as context.
      const prompt = linked ? `(replying to session ${linked.session_id.slice(0, 6)})\n${text}` : text;

      // The agent starts working (spawns/sends to a session) via a tool call, which
      // shows up here as a session.input event — the first sign anything is happening.
      const onWorkStarted = (e: BuilderEvent) => {
        if (e.kind === "session.input") void ctx.reply(`⚙️ working on it…`).catch(() => {});
      };
      bus.once("event", onWorkStarted);

      const renderer = new TelegramRenderer(ctx, { throttleMs: 600, draftStreaming: true });
      let finalText = "";
      await renderer.render(<AgentReply prompt={prompt} onDone={(t) => (finalText = t)} />);
      bus.off("event", onWorkStarted);
      log.info(`turn done: ${finalText.length} chars`);
    } catch (err) {
      log.error("turn failed", err);
      await ctx.reply(`error: ${(err as Error).message}`);
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

function tagText(project: string | undefined, shortId: string) {
  const url = config.dashboard.url;
  const label = shortId ? `${project} · ${url ? `<a href="${url}/?s=${shortId}">${shortId}</a>` : shortId}` : "builder";
  return `[${label}]`;
}

/** Session activity goes to the chat and into the agent's memory of the conversation. */
async function relay(e: BuilderEvent, send: (text: string) => Promise<{ message_id: number }>) {
  const short = e.sessionId?.slice(0, 6) ?? "";
  const tag = tagText(e.project, short);
  try {
    if (e.kind === "session.turn_end") {
      const text = String(e.payload.text ?? "").trim();
      if (!text) return;
      const sent = await send(`${tag}\n${escapeHtml(text)}`);
      if (e.sessionId) link(sent.message_id, e.sessionId);
    } else if (e.kind === "session.exit" && e.payload.code !== 0) {
      await send(`${tag} session exited (code ${e.payload.code})`);
    } else if (e.kind === "rate_limit" && e.payload.status !== "allowed") {
      await send(`rate limit: ${e.payload.status}`);
    }
  } catch (err) {
    log.warn("relay failed", (err as Error).message);
  }
}

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function clip(s: string, max = 4000) {
  return s.length <= max ? s : `${s.slice(0, max - 20)}\n… (truncated)`;
}
