import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { config } from "../core/config.ts";
import { logger } from "../core/log.ts";

const log = logger("tg-user");

let client: TelegramClient | undefined;

export function enabled() {
  const { apiId, apiHash, session } = config.telegramUser;
  return Boolean(apiId && apiHash && session);
}

/** One MTProto connection for the whole daemon, opened on first use. */
async function tg(): Promise<TelegramClient> {
  if (client?.connected) return client;
  const { apiId, apiHash, session } = config.telegramUser;
  client ??= new TelegramClient(new StringSession(session), apiId, apiHash, { connectionRetries: 3 });
  client.setLogLevel("error" as never);
  await client.connect();
  if (!(await client.isUserAuthorized())) throw new Error("telegram user session is not authorized; re-login needed");
  log.info("connected as user");
  return client;
}

export async function disconnectUser() {
  await client?.disconnect().catch(() => {});
}

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const peerArg = z.string().describe("username (@name), phone, numeric id, or exact chat title as returned by list_chats");

function name(e: unknown): string {
  const x = e as Record<string, any> | undefined;
  if (!x) return "";
  if (x.title) return x.title;
  return [x.firstName, x.lastName].filter(Boolean).join(" ") || x.username || String(x.id ?? "");
}

function messageRow(m: Api.Message, chat?: string) {
  const sender = m.sender ? name(m.sender) : m.out ? "me" : "";
  return {
    id: m.id,
    date: new Date(m.date * 1000).toISOString(),
    from: sender,
    out: m.out ?? false,
    text: (m.message ?? "").slice(0, 2000),
    media: m.media ? m.media.className.replace("MessageMedia", "").toLowerCase() : undefined,
    replyTo: m.replyTo && "replyToMsgId" in m.replyTo ? m.replyTo.replyToMsgId : undefined,
    chat,
  };
}

async function resolve(c: TelegramClient, peer: string) {
  const trimmed = peer.trim();
  if (/^-?\d+$/.test(trimmed)) return c.getEntity(trimmed);
  if (trimmed.startsWith("@") || trimmed.startsWith("+")) return c.getEntity(trimmed);
  try {
    return await c.getEntity(trimmed);
  } catch {
    const dialogs = await c.getDialogs({ limit: 200 });
    const hit = dialogs.find((d) => d.title?.toLowerCase() === trimmed.toLowerCase()) ?? dialogs.find((d) => d.title?.toLowerCase().includes(trimmed.toLowerCase()));
    if (!hit?.entity) throw new Error(`no chat matching "${peer}"`);
    return hit.entity;
  }
}

/**
 * The user's own Telegram, exposed as tools. Sending is the one irreversible action here;
 * the session instructions make the model confirm before using it.
 */
export function telegramUserTools() {
  return createSdkMcpServer({
    name: "tg",
    version: "1.0.0",
    instructions:
      "These tools act as the user's own Telegram account (not the bot). Reading is free; send_message is visible to other people, confirm with the user first unless they asked for exactly this message to exactly this person.",
    tools: [
      tool(
        "list_chats",
        "The user's recent Telegram chats (dialogs), newest activity first, with unread counts and the last message.",
        { limit: z.number().min(1).max(100).default(30), query: z.string().optional().describe("filter by chat title substring") },
        async ({ limit, query }) => {
          const c = await tg();
          const dialogs = await c.getDialogs({ limit: query ? 200 : limit });
          const rows = dialogs
            .filter((d) => !query || d.title?.toLowerCase().includes(query.toLowerCase()))
            .slice(0, limit)
            .map((d) => ({
              title: d.title,
              id: String(d.id),
              kind: d.isUser ? "user" : d.isChannel ? "channel" : "group",
              unread: d.unreadCount,
              last: d.message ? { date: new Date(d.message.date * 1000).toISOString(), from: d.message.out ? "me" : name(d.message.sender), text: (d.message.message ?? "").slice(0, 160) } : undefined,
            }));
          return ok(rows);
        },
      ),
      tool(
        "read_chat",
        "Recent messages in one chat, newest first.",
        { peer: peerArg, limit: z.number().min(1).max(200).default(30), before_id: z.number().optional().describe("page back: only messages older than this id") },
        async ({ peer, limit, before_id }) => {
          const c = await tg();
          const entity = await resolve(c, peer);
          const msgs = await c.getMessages(entity, { limit, offsetId: before_id });
          return ok({ chat: name(entity), messages: msgs.map((m) => messageRow(m)) });
        },
      ),
      tool(
        "search_messages",
        "Full-text search across all chats, or inside one chat when peer is given.",
        { query: z.string(), peer: peerArg.optional(), limit: z.number().min(1).max(100).default(20) },
        async ({ query, peer, limit }) => {
          const c = await tg();
          if (peer) {
            const entity = await resolve(c, peer);
            const msgs = await c.getMessages(entity, { search: query, limit });
            return ok(msgs.map((m) => messageRow(m, name(entity))));
          }
          const res = await c.invoke(
            new Api.messages.SearchGlobal({
              q: query,
              filter: new Api.InputMessagesFilterEmpty(),
              minDate: 0,
              maxDate: 0,
              offsetRate: 0,
              offsetPeer: new Api.InputPeerEmpty(),
              offsetId: 0,
              limit,
            }),
          );
          const chats = new Map<string, string>();
          if ("chats" in res) for (const ch of res.chats) chats.set(String(ch.id), name(ch));
          if ("users" in res) for (const u of res.users) chats.set(String(u.id), name(u));
          const messages = "messages" in res ? (res.messages as Api.Message[]) : [];
          return ok(
            messages.filter((m) => m instanceof Api.Message).map((m) => {
              const pid = m.peerId as Record<string, any>;
              const key = String(pid.userId ?? pid.chatId ?? pid.channelId ?? "");
              return messageRow(m, chats.get(key));
            }),
          );
        },
      ),
      tool(
        "send_message",
        "Send a Telegram message as the user. Other people see it immediately; confirm first.",
        { peer: peerArg, text: z.string().min(1).max(4096), reply_to: z.number().optional() },
        async ({ peer, text, reply_to }) => {
          const c = await tg();
          const entity = await resolve(c, peer);
          const sent = await c.sendMessage(entity, { message: text, replyTo: reply_to });
          log.info(`sent to ${name(entity)}: ${text.slice(0, 60)}`);
          return ok({ sent: true, chat: name(entity), id: sent.id });
        },
      ),
      tool(
        "mark_read",
        "Mark a chat as read.",
        { peer: peerArg },
        async ({ peer }) => {
          const c = await tg();
          const entity = await resolve(c, peer);
          await c.markAsRead(entity);
          return ok({ read: name(entity) });
        },
      ),
    ],
  });
}
