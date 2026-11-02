import { config } from "../core/config.ts";
import { logger } from "../core/log.ts";
import * as credits from "./credits.ts";
import * as spend from "./spend.ts";

/**
 * One short completion for small jobs (summaries, headlines, a connector's `complete`): Haiku on the
 * plan's API credits while they last, a cheap gateway model when there is no key or they are spent.
 */

const log = logger("small-model");
const GATEWAY = "https://ai-gateway.vercel.sh/v1/chat/completions";
// A model that answers without thinking first: a reasoning one spends the whole budget on its reasoning and returns nothing.
const MODEL = "google/gemini-2.5-flash-lite";
const GATEWAY_TIMEOUT_MS = 30_000;

export const enabled = () => Boolean(config.aiGatewayKey || config.anthropicKey);

export async function complete(system: string, user: string, maxTokens: number, what: string): Promise<string> {
  if (credits.enabled())
    try {
      return await credits.complete(system, user, maxTokens, what);
    } catch (err) {
      if (!config.aiGatewayKey) throw err;
      if (!credits.exhausted(err)) log.warn(`credits: ${(err as Error).message}`);
    }
  return gateway(system, user, maxTokens, what);
}

async function gateway(system: string, user: string, maxTokens: number, what: string): Promise<string> {
  const started = Date.now();
  const response = await fetch(GATEWAY, {
    method: "POST",
    headers: { authorization: `Bearer ${config.aiGatewayKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
    signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`gateway ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const data = (await response.json()) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number } };
  spend.recordGateway(MODEL, data.usage, Date.now() - started, what);
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("gateway answered without text");
  return text;
}
