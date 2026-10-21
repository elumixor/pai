import Anthropic from "@anthropic-ai/sdk";
import { config } from "../core/config.ts";
import { now } from "../core/db.ts";
import { resolve } from "./models.ts";
import * as spend from "./spend.ts";

/**
 * Calls billed to the Max plan's monthly API credits (`PAI_ANTHROPIC_API_KEY`): small jobs that
 * would otherwise cost money on the gateway, or Max limits through the login. A caller falls back
 * to its old path whenever this throws — no key, or the month's credits spent.
 */

let client: Anthropic | undefined;

export const enabled = () => Boolean(config.anthropicKey);

/** The answer the API gives once the credits are gone; until the next grant only the fallback works. */
export const exhausted = (err: unknown) => /credit balance is too low/i.test(String((err as Error)?.message ?? err));

/** One short completion on the newest Haiku, thinking kept low: these are one-line jobs. */
export async function complete(system: string, user: string, maxTokens: number, what: string): Promise<string> {
  if (!config.anthropicKey) throw new Error("no PAI_ANTHROPIC_API_KEY");
  client ??= new Anthropic({ apiKey: config.anthropicKey, maxRetries: 1, timeout: 30_000 });
  const started = now();
  const response = await client.messages.create({
    model: resolve("haiku"),
    max_tokens: maxTokens + 1_000,
    output_config: { effort: "low" },
    system,
    messages: [{ role: "user", content: user }],
  });
  const t = spend.tokensOf(response.usage);
  spend.record({
    ref: `credits:${response.id}`,
    ts: started,
    source: "credits",
    billing: "credits",
    agent: what,
    model: response.model,
    input: t.input,
    output: t.output,
    cacheRead: t.cacheRead,
    cacheWrite: t.cacheWrite5m + t.cacheWrite1h,
    costUsd: spend.price(response.model, t),
    ms: now() - started,
  });
  const text = response.content
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("")
    .trim();
  if (!text) throw new Error(`no text (${response.stop_reason})`);
  return text;
}
