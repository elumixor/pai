import { config } from "../core/config.ts";
import { logger } from "../core/log.ts";
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
  const who = m.from.replace(/^(watcher|routine):/, "");
  const text = await complete(
    "You write one headline for a row in a personal assistant's activity log: at most six words, no period, no quotes. Name the people and things, drop the rest. Examples: 'Dmytro asks for work', 'Dmytro connects on Telegram', 'Daily follow-up', 'Approved draft to Dmytro', 'ATMA completed Hiring Developer'. A report from an agent starts with the agent's name. An answered question is headlined by what was decided.",
    `kind: ${m.kind}${m.meta.event ? ` (${m.meta.event})` : ""}
from: ${who}

${m.body.slice(0, 4_000)}${answer ? `

answer: ${answer}` : ""}`,
    40,
  );
  const line = text.replace(/^["'“”]+|["'“”.]+$/g, "").split("\n")[0]!.trim();
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
