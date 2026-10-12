import { config } from "../core/config.ts";

/**
 * The decision model: Jev, a System One model (TypeSafe), reached through the Vercel AI Gateway's
 * TypeSafe-compatible endpoint with `AI_GATEWAY_API_KEY`. One forward pass over a state and typed
 * questions, back come probabilities, never text — ~$0.00002 and ~350ms a call, so a judgement
 * that used to need a model turn costs nothing worth counting. Control flow stays in code: the
 * model answers narrow questions, the caller combines them.
 */

export interface Noul {
  readonly type: "noul";
  readonly instructions: string;
  readonly criteria?: { readonly true: string; readonly false: string };
}
export interface Choice {
  readonly type: "choice";
  readonly instructions: string;
  readonly criteria: Record<string, string | null>;
}
export type Question = Noul | Choice;

export interface NoulAnswer {
  readonly type: "noul";
  readonly noul: number;
}
export interface ChoiceAnswer {
  readonly type: "choice";
  readonly choice: string;
  readonly confidence: number;
  readonly probabilities: Record<string, number>;
}
export type Answer = NoulAnswer | ChoiceAnswer;

const ENDPOINT = "https://ai-gateway.vercel.sh/typesafe/v1/systemone";

export const enabled = () => Boolean(config.aiGatewayKey);

export type Answers<Q extends Record<string, Question>> = { [K in keyof Q]: Q[K] extends Noul ? NoulAnswer : ChoiceAnswer };

/** One call: every question answered in parallel over the same state. */
export async function ask<Q extends Record<string, Question>>(state: unknown, questions: Q): Promise<Answers<Q>> {
  return (await impl(state, questions)) as Answers<Q>;
}

/** The call itself; tests replace it. */
let impl: (state: unknown, questions: Record<string, Question>) => Promise<Record<string, Answer>> = async (state, questions) => {
  if (!config.aiGatewayKey) throw new Error("no AI_GATEWAY_API_KEY");
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.aiGatewayKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: config.models.gate, state, questions }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  const out = (await res.json()) as { answers: Record<string, Answer> };
  return out.answers;
};
export function setAsk(fn: typeof impl) {
  impl = fn;
}

/** The chosen option's probability, when the answer is a choice. */
export const probability = (a: ChoiceAnswer, option: string) => a.probabilities[option] ?? 0;
