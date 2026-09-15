import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { bus } from "../core/bus.ts";
import { config } from "../core/config.ts";
import { kv } from "../core/db.ts";
import { logger } from "../core/log.ts";
import type { Module } from "./types.ts";

const log = logger("linkedin");

/**
 * LinkedIn messages, through the same private API the website uses (there is no public one
 * for a personal inbox). It needs two cookies from a signed-in browser: `li_at` and
 * `JSESSIONID`, the second doubling as the CSRF token. The poller emits `linkedin.message`
 * for every conversation whose newest message it has not seen; the tools let a session
 * read the inbox and answer in it.
 */

const VOYAGER = "https://www.linkedin.com/voyager/api";
const SEEN_KEY = "linkedin_seen";
const MIN_INTERVAL = 60 * 1000;

export interface Conversation {
  readonly id: string;
  readonly url: string;
  readonly with: string;
  readonly lastAt: string;
  readonly lastFrom: string;
  readonly lastText: string;
  readonly unread: boolean;
}

interface Voyager {
  elements?: Record<string, any>[];
  included?: Record<string, any>[];
}

const cookies = () => ({ liAt: config.linkedin.liAt, jsessionid: config.linkedin.jsessionid });

function headers() {
  const { liAt, jsessionid } = cookies();
  return {
    cookie: `li_at=${liAt}; JSESSIONID="${jsessionid}"`,
    "csrf-token": jsessionid,
    accept: "application/vnd.linkedin.normalized+json+2.1",
    "x-restli-protocol-version": "2.0.0",
    "x-li-lang": "en_US",
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  };
}

async function voyager<T = Voyager>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${VOYAGER}${path}`, { ...init, headers: { ...headers(), ...(init.headers ?? {}) }, signal: AbortSignal.timeout(20_000) });
  if (response.status === 401 || response.status === 403) throw new Error("linkedin: signed out — the cookies expired");
  if (!response.ok) throw new Error(`linkedin: ${response.status} on ${path}`);
  return (await response.json()) as T;
}

const nameOf = (profile: Record<string, any> | undefined) =>
  profile ? `${profile.firstName ?? ""} ${profile.lastName ?? ""}`.trim() : "someone";

/** The inbox as the site shows it: one row per conversation, newest first. */
export async function inbox(limit = 20): Promise<Conversation[]> {
  const data = await voyager(`/messaging/conversations?keyVersion=LEGACY_INBOX&count=${limit}`);
  const included = new Map((data.included ?? []).map((item) => [item.entityUrn as string, item]));
  const me = kv.get("linkedin_me") ?? "";
  return (data.elements ?? []).map((conversation) => {
    const urn = String(conversation.entityUrn ?? conversation["*conversation"] ?? "");
    const id = urn.split(":").pop()?.replace(/^.*?fs_conversation:/, "") ?? urn;
    const participants: string[] = ((conversation["*participants"] ?? conversation.participants ?? []) as any[])
      .map((p) => (typeof p === "string" ? included.get(p) : p))
      .map((p) => nameOf(p?.["com.linkedin.voyager.messaging.MessagingMember"]?.miniProfile ?? p?.miniProfile ?? p));
    const events: any[] = (conversation["*events"] ?? conversation.events ?? []).map((e: unknown) => (typeof e === "string" ? included.get(e) : e));
    const last = events[0];
    const fromUrn = String(last?.["*from"] ?? last?.from?.["com.linkedin.voyager.messaging.MessagingMember"]?.entityUrn ?? "");
    const fromProfile = included.get(fromUrn)?.miniProfile ?? last?.from?.["com.linkedin.voyager.messaging.MessagingMember"]?.miniProfile;
    return {
      id,
      url: `https://www.linkedin.com/messaging/thread/${id}/`,
      with: participants.filter(Boolean).join(", "),
      lastAt: new Date(Number(last?.createdAt ?? conversation.lastActivityAt ?? 0)).toISOString(),
      lastFrom: fromUrn && me && fromUrn.includes(me) ? "me" : nameOf(fromProfile),
      lastText: String(last?.eventContent?.["com.linkedin.voyager.messaging.event.MessageEvent"]?.attributedBody?.text ?? last?.eventContent?.attributedBody?.text ?? "").trim(),
      unread: Boolean(conversation.read === false || conversation.unreadCount),
    };
  });
}

/** The messages of one conversation, oldest first. */
export async function thread(id: string, limit = 40) {
  const data = await voyager(`/messaging/conversations/${encodeURIComponent(id)}/events?count=${limit}`);
  const included = new Map((data.included ?? []).map((item) => [item.entityUrn as string, item]));
  return (data.elements ?? [])
    .map((event) => {
      const fromUrn = String(event["*from"] ?? "");
      const profile = included.get(fromUrn)?.miniProfile ?? event.from?.["com.linkedin.voyager.messaging.MessagingMember"]?.miniProfile;
      return {
        at: new Date(Number(event.createdAt ?? 0)).toISOString(),
        from: nameOf(profile),
        text: String(event.eventContent?.["com.linkedin.voyager.messaging.event.MessageEvent"]?.attributedBody?.text ?? event.eventContent?.attributedBody?.text ?? "").trim(),
      };
    })
    .reverse();
}

export async function reply(id: string, text: string) {
  await voyager(`/messaging/conversations/${encodeURIComponent(id)}/events?action=create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      eventCreate: { value: { "com.linkedin.voyager.messaging.create.MessageCreate": { attributedBody: { text, attributes: [] }, attachments: [] } } },
    }),
  });
  return { sent: true, id };
}

let timer: ReturnType<typeof setInterval> | undefined;
let lastPoll: { at: string; ok: boolean; error?: string; conversations: number } | undefined;

/** Emits an event for every conversation whose newest message is new since the last poll. */
export async function poll() {
  const seen = new Map<string, string>(Object.entries(JSON.parse(kv.get(SEEN_KEY) ?? "{}") as Record<string, string>));
  try {
    const rows = await inbox(25);
    const first = seen.size === 0;
    for (const row of rows) {
      const before = seen.get(row.id);
      seen.set(row.id, row.lastAt);
      // The first poll only learns what is there; announcing a whole inbox would be noise.
      if (first || before === row.lastAt || row.lastFrom === "me") continue;
      bus.emitEvent("linkedin.message", { conversation: row.id, url: row.url, from: row.lastFrom, with: row.with, text: row.lastText, at: row.lastAt });
    }
    kv.set(SEEN_KEY, JSON.stringify(Object.fromEntries(seen)));
    lastPoll = { at: new Date().toISOString(), ok: true, conversations: rows.length };
  } catch (err) {
    lastPoll = { at: new Date().toISOString(), ok: false, error: (err as Error).message, conversations: 0 };
    log.warn(lastPoll.error!);
  }
  return lastPoll;
}

export function linkedinTools() {
  const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
  return createSdkMcpServer({
    name: "linkedin",
    version: "1.0.0",
    tools: [
      tool("linkedin_inbox", "The LinkedIn inbox: who wrote, when, and the last message of each conversation, newest first.", { limit: z.number().optional() }, async ({ limit }) =>
        ok(await inbox(limit ?? 20).catch((err: Error) => ({ error: err.message }))),
      ),
      tool("linkedin_thread", "Every message in one LinkedIn conversation, oldest first.", { conversation: z.string() }, async ({ conversation }) =>
        ok(await thread(conversation).catch((err: Error) => ({ error: err.message }))),
      ),
      tool(
        "linkedin_reply",
        "Send a message in a LinkedIn conversation, as the user. Confirm the text with the user first: it goes to a real person under their name.",
        { conversation: z.string(), text: z.string().max(4000) },
        async ({ conversation, text }) => ok(await reply(conversation, text).catch((err: Error) => ({ error: err.message }))),
      ),
    ],
  });
}

export const linkedinModule: Module = {
  name: "linkedin",
  title: "LinkedIn",
  description: "Watches the LinkedIn inbox and lets sessions read and answer it.",
  kind: "source",
  enabled: () => config.linkedin.enabled && Boolean(config.linkedin.liAt && config.linkedin.jsessionid),
  status: () => ({ configured: Boolean(config.linkedin.liAt && config.linkedin.jsessionid), polling: Boolean(timer), lastPoll, intervalMinutes: config.linkedin.intervalMinutes }),
  tools: { server: "linkedin", names: ["linkedin_inbox", "linkedin_thread", "linkedin_reply"], kinds: ["main", "task", "code"] },
  prompt: {
    text: "LinkedIn: linkedin_inbox lists conversations, linkedin_thread reads one, linkedin_reply answers as the user — always confirm the wording with AskUserQuestion before sending.",
    kinds: ["main", "task"],
  },
  events: [{ kind: "linkedin.message", description: "a new message arrived in a conversation (from, with, text, url)" }],
  settings: [
    { key: "PAI_LINKEDIN", label: "Enabled", type: "toggle" },
    { key: "PAI_LINKEDIN_LI_AT", label: "li_at cookie", hint: "from a signed-in browser: DevTools → Application → Cookies → linkedin.com", secret: true },
    { key: "PAI_LINKEDIN_JSESSIONID", label: "JSESSIONID cookie", hint: "the value without the quotes, e.g. ajax:123…", secret: true },
    { key: "PAI_LINKEDIN_INTERVAL", label: "Poll every (minutes)", type: "number" },
  ],
  start() {
    if (!linkedinModule.enabled() || timer) return;
    const every = Math.max(MIN_INTERVAL, config.linkedin.intervalMinutes * 60 * 1000);
    timer = setInterval(() => void poll(), every);
    void poll();
    log.info(`polling the inbox every ${Math.round(every / 60000)} min`);
  },
  stop() {
    clearInterval(timer);
    timer = undefined;
  },
};
