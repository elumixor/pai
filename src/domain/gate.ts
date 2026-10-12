import { config } from "../core/config.ts";
import { logger } from "../core/log.ts";

const log = logger("gate");

/**
 * A report from an agent used to cost pai a full turn even when all it had to say was "no response
 * needed": every turn runs the big model over pai's whole context. A decision model (Jev, a System
 * One model: one forward pass, typed answers with probabilities, no text) now reads each report in
 * the batch first and says what it needs from the orchestrator — nothing, an action, or the user.
 * A batch whose every report is "nothing" with high probability is injected into pai's context
 * instead (no model call; pai still sees it on its next turn), and a nudge after a while makes sure
 * nothing deferred is lost. The gate fails open: no key, an error, or a doubt means a turn, as before.
 *
 * Reached through the Vercel AI Gateway's TypeSafe-compatible endpoint (`AI_GATEWAY_API_KEY`), so
 * no TypeSafe account is needed; ~$0.00002 and ~350ms a call.
 */

/** A report is deferred only when the model puts "nothing to do" at this or above (acts from 20% on). */
export const NOTHING_AT = 0.8;
/** Deferred reports earn pai one turn after this long without one, so nothing waits past it. */
export const NUDGE_MS = 30 * 60_000;
const ENDPOINT = "https://ai-gateway.vercel.sh/typesafe/v1/systemone";

/** What one report needs from the orchestrator, as the model's probabilities. */
export interface Need {
  readonly nothing: number;
  readonly act: number;
  readonly user: number;
}
export interface Verdict {
  readonly act: boolean;
  readonly needs: Need[];
  readonly reason: string;
}

const QUESTION = {
  type: "choice",
  instructions: "What does this report need from the orchestrator next?",
  criteria: {
    nothing: "Nothing: the work is finished or the status changes nothing; the orchestrator only needs to know",
    act: "The orchestrator acts: hands an agent the next step, fixes a misroute, unblocks a failure, raises a budget, closes or updates a task",
    user: "A question or decision that only the user can answer",
  },
};

/** The reports in a batch: each starts with `[Agent name]` on its own paragraph. */
export function split(batch: string): string[] {
  const body = batch.replace(/\n\n\[Handle this yourself:[^]*$/, "");
  const parts = body.split(/\n\n(?=\[[^\]\n]+\] )/).map((p) => p.trim()).filter(Boolean);
  return parts.length ? parts : [body.trim()];
}

/** One decision-model call for the whole batch: a question per report, answered in parallel. Replaced in tests. */
let judge: (reports: string[]) => Promise<Need[]> = async (reports) => {
  if (!config.aiGatewayKey) throw new Error("no AI_GATEWAY_API_KEY");
  const state = Object.fromEntries(reports.map((r, i) => [`r${i}`, r.slice(0, 6000)]));
  const questions = Object.fromEntries(reports.map((_, i) => [`r${i}`, { ...QUESTION, instructions: `What does \`r${i}\` need from the orchestrator next?` }]));
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.aiGatewayKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: config.models.gate, state, questions }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  const out = (await res.json()) as { answers: Record<string, { probabilities?: Record<string, number> }> };
  return reports.map((_, i) => {
    const p = out.answers[`r${i}`]?.probabilities ?? {};
    return { nothing: p.nothing ?? 0, act: p.act ?? 1, user: p.user ?? 0 };
  });
};
export function setJudge(fn: typeof judge) {
  judge = fn;
}

export interface Sinks {
  /** A turn for pai. */
  turn(text: string): void;
  /** Context for pai's next turn, no turn now. */
  note(text: string): void;
}

const NUDGE = "[Reports handed to you above without a turn of their own. Act on any that need it — the next step to an agent, the task list, closing what is done — else end with no text.]";

let deferred = 0;
let nudge: ReturnType<typeof setTimeout> | undefined;

/** How many batches sit in pai's context waiting for its next turn. */
export const pending = () => deferred;

/** pai took a turn (any origin): whatever was deferred has been seen. */
export function turnTaken() {
  deferred = 0;
  clearTimeout(nudge);
  nudge = undefined;
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

/** Screens a batch of reports and sends it the cheaper way it can go. */
export async function screen(text: string, sinks: Sinks): Promise<Verdict> {
  const reports = split(text);
  let needs: Need[];
  try {
    needs = await judge(reports);
  } catch (err) {
    log.warn(`gate failed, turning: ${(err as Error).message}`);
    sinks.turn(text);
    return { act: true, needs: [], reason: "gate failed" };
  }
  const summary = needs.map((n, i) => `${reports[i]!.slice(0, 40).replace(/\s+/g, " ")}… nothing ${pct(n.nothing)} act ${pct(n.act)} user ${pct(n.user)}`).join(" | ");
  const act = needs.some((n) => n.nothing < NOTHING_AT);
  if (act) {
    log.info(`turn: ${summary}`);
    sinks.turn(text);
    return { act, needs, reason: summary };
  }
  log.info(`deferred: ${summary}`);
  deferred += 1;
  sinks.note(text);
  nudge ??= setTimeout(() => {
    nudge = undefined;
    if (deferred) sinks.turn(NUDGE);
  }, NUDGE_MS);
  return { act, needs, reason: summary };
}

/** Whether a reply is only the boilerplate pai says when it has nothing to say; the chat log skips it. */
export function boilerplate(text: string): boolean {
  const t = text.replace(/[*_`~()\[\]\s]+/g, " ").trim().toLowerCase();
  return t.length <= 48 && /^(no (response|action|reply) (is )?needed|nothing (to do|needed|for you)|no(thing)? (further|new)( for you)?|done)[.!…]*$/.test(t);
}
