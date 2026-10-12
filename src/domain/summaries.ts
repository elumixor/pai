import { bus } from "../core/bus.ts";
import { config } from "../core/config.ts";
import { logger } from "../core/log.ts";
import * as agents from "./agents.ts";
import * as asks from "./asks.ts";
import * as messages from "./messages.ts";

/**
 * The gist of a long message, in a sentence or two, so a chat can show what a reply or a
 * report amounts to and keep the rest behind "details". Written once by a small model through
 * the Vercel AI Gateway (`AI_GATEWAY_API_KEY`), kept in the message's `meta.tldr`.
 */

const log = logger("tldr");
const GATEWAY = "https://ai-gateway.vercel.sh/v1/chat/completions";
// A model that answers without thinking first: a reasoning one spends the whole budget on its reasoning and returns nothing.
const MODEL = "google/gemini-2.5-flash-lite";
/** Shorter than this a message is its own summary. */
export const SHORT = 400;

const inFlight = new Map<string, Promise<string | undefined>>();
/** Shorter than this a message is its own headline. */
const HEADLINE_SHORT = 40;
/** The kinds that show as one line and so get a headline; the rest are read in full. */
const HEADLINED = new Set(["event", "report", "request", "response", "ask", "notice"]);
/** How many recent rows a starting daemon headlines. */
const BACKFILL = 100;

export const enabled = () => Boolean(config.aiGatewayKey);

/** The summary for a message: what it has, else one written now; undefined when there is no key or the model fails. */
export function tldr(id: number): Promise<string | undefined> {
  const m = messages.get(id);
  if (!m) return Promise.resolve(undefined);
  if (typeof m.meta.tldr === "string") return Promise.resolve(m.meta.tldr);
  if (!enabled() || m.body.length < SHORT) return Promise.resolve(undefined);
  return once(`tldr:${id}`, () => write(m));
}

/**
 * A headline for a row of the log — "Dmytro asks for work", "Approved draft to Dmytro" — at most
 * six words, kept in `meta.headline`. An answered ask is headlined with its answer, so the line
 * says what was decided.
 */
export function headline(id: number): Promise<string | undefined> {
  const m = messages.get(id);
  if (!m) return Promise.resolve(undefined);
  if (typeof m.meta.headline === "string") return Promise.resolve(m.meta.headline);
  const answer = m.kind === "ask" && typeof m.meta.askId === "number" ? asks.getAsk(m.meta.askId)?.answer : undefined;
  if (!enabled() || (m.body.length < HEADLINE_SHORT && !answer)) return Promise.resolve(undefined);
  return once(`headline:${id}`, () => writeHeadline(m, answer ?? undefined));
}

function once(key: string, work: () => Promise<string>) {
  const pending = inFlight.get(key);
  if (pending) return pending;
  const task = work()
    .catch((err: Error) => {
      log.warn(`${key}: ${err.message}`);
      return undefined;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, task);
  return task;
}

async function writeHeadline(m: messages.Message, answer?: string): Promise<string> {
  const agent = agents.get(m.from)?.name ?? agents.get(m.to)?.name;
  const source = typeof m.meta.source === "string" ? m.meta.source : m.from.startsWith("watcher:") ? m.from.slice(8) : m.from.startsWith("routine:") ? "routine" : undefined;
  const text = await complete(
    "You write one headline for a row in a personal assistant's activity log: three to six words, no period, no quotes, no markdown. Say who and what happened, and always where it came from: an email says 'emails' or 'by email', Telegram says 'on Telegram', LinkedIn says 'on LinkedIn', a routine is named by its name, a report or a request from an agent starts with the agent's name. Examples: 'Dmytro emails asking for work', 'Dmytro connects on Telegram', 'Daily follow-up ran', 'Approved draft to Dmytro', 'ATMA completed Hiring Developer', 'You wrote to Mama on Telegram'. An answered question is headlined by what was decided.",
    `kind: ${m.kind}${m.meta.event ? ` (${m.meta.event})` : ""}${source ? `\nsource: ${source}` : ""}${agent ? `\nagent: ${agent}` : ""}\n\n${m.body.slice(0, 4_000)}${answer ? `\n\nanswer: ${answer}` : ""}`,
    40,
  );
  const line = text.replace(/\*\*|__/g, "").replace(/^["'“”]+|["'“”.]+$/g, "").split("\n")[0]!.trim().split(/\s+/).slice(0, 7).join(" ");
  messages.patchMeta(m.id, { headline: line });
  return line;
}

async function write(m: messages.Message): Promise<string> {
  const text = await complete(
    "You write the gist of a message from a personal assistant to its user. One or two sentences, up to three when the message holds several decisions. Keep names, numbers, dates and what is asked of the user. Markdown inline marks are fine; no preamble, no quotes, no bullet list.",
    m.body.slice(0, 12_000),
    300,
  );
  messages.patchMeta(m.id, { tldr: text });
  return text;
}

async function complete(system: string, user: string, maxTokens: number): Promise<string> {
  const response = await fetch(GATEWAY, {
    method: "POST",
    headers: { authorization: `Bearer ${config.aiGatewayKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`gateway ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("gateway answered without text");
  return text;
}

/**
 * Headlines are written as rows land, and the last hundred are caught up when the daemon
 * starts, so a chat rarely has to ask for one. One at a time: the gateway is cheap, a burst
 * at start is not. Returns a way to stop.
 */
export function start() {
  if (!enabled()) return () => {};
  const queue: number[] = [];
  let draining = false;
  const drain = async () => {
    if (draining) return;
    draining = true;
    try {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) await headline(id);
    } finally {
      draining = false;
    }
  };
  const wants = (m: { kind: string; meta: Record<string, unknown> }) => HEADLINED.has(m.kind) && typeof m.meta.headline !== "string";
  const handler = (e: { kind: string; payload: Record<string, unknown> }) => {
    if (e.kind !== "message.new") return;
    const m = e.payload as unknown as messages.Message;
    if (!wants(m)) return;
    queue.push(m.id);
    void drain();
  };
  bus.on("event", handler);
  const catchUp = setTimeout(() => {
    const recent = messages.list({ limit: BACKFILL * 3 }).filter(wants).slice(0, BACKFILL);
    queue.push(...recent.map((m) => m.id));
    if (recent.length) log.info(`headlining ${recent.length} recent rows`);
    void drain();
  }, 15_000);
  return () => {
    clearTimeout(catchUp);
    bus.off("event", handler);
  };
}
