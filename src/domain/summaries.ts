import { config } from "../core/config.ts";
import { logger } from "../core/log.ts";
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

const inFlight = new Map<number, Promise<string | undefined>>();

export const enabled = () => Boolean(config.aiGatewayKey);

/** The summary for a message: what it has, else one written now; undefined when there is no key or the model fails. */
export function tldr(id: number): Promise<string | undefined> {
  const m = messages.get(id);
  if (!m) return Promise.resolve(undefined);
  if (typeof m.meta.tldr === "string") return Promise.resolve(m.meta.tldr);
  if (!enabled() || m.body.length < SHORT) return Promise.resolve(undefined);
  const pending = inFlight.get(id);
  if (pending) return pending;
  const task = write(m)
    .catch((err: Error) => {
      log.warn(`tldr #${id}: ${err.message}`);
      return undefined;
    })
    .finally(() => inFlight.delete(id));
  inFlight.set(id, task);
  return task;
}

async function write(m: messages.Message): Promise<string> {
  const response = await fetch(GATEWAY, {
    method: "POST",
    headers: { authorization: `Bearer ${config.aiGatewayKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 300,
      messages: [
        {
          role: "system",
          content:
            "You write the gist of a message from a personal assistant to its user. One or two sentences, up to three when the message holds several decisions. Keep names, numbers, dates and what is asked of the user. Markdown inline marks are fine; no preamble, no quotes, no bullet list.",
        },
        { role: "user", content: m.body.slice(0, 12_000) },
      ],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`gateway ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("gateway answered without text");
  messages.patchMeta(m.id, { tldr: text });
  return text;
}
