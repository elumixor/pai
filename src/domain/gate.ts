import { query } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../core/config.ts";
import { logger } from "../core/log.ts";

const log = logger("gate");

/**
 * A report from an agent used to cost pai a full turn even when all it had to say was "no response
 * needed": every turn runs the big model over pai's whole context. A small model now reads the batch
 * first and says how likely it is that pai has to act — hand the next step to an agent, close a task,
 * ask the user. Below the threshold the batch is injected into pai's context instead (no model call;
 * pai still sees it on its next turn), and a nudge after a while makes sure nothing deferred is lost.
 * The gate fails open: an error means a turn, as before.
 */

/** Act once the small model puts the odds of pai having to do something at this or above. */
export const THRESHOLD = 0.2;
/** Deferred reports earn pai one turn after this long without one, so nothing waits past it. */
export const NUDGE_MS = 30 * 60_000;

export interface Verdict {
  readonly act: boolean;
  readonly odds: number;
  readonly reason: string;
}

const SCHEMA = {
  type: "object",
  properties: {
    odds: { type: "number", minimum: 0, maximum: 1, description: "probability that the orchestrator must do something now" },
    reason: { type: "string" },
  },
  required: ["odds", "reason"],
};

const PROMPT = `You screen reports that an assistant's staff (agents) send to it. The assistant is an orchestrator: it acts when a report needs a next step handed to an agent, a task closed or updated, a question put to the user, a failure handled, or a request answered. It need not act when the report is purely informational: work finished with nothing further, a status that changes nothing, an acknowledgement, an agent saying it is waiting on the user.

Give the probability (0..1) that the orchestrator must do something now in response to the batch below, and a short reason. Anything that reads as a question to the orchestrator, an error, a blocked agent, a spent budget, or an unfinished job is at least 0.5.

Batch:
`;

/** One small-model turn, no tools, structured output. Replaced in tests. */
let judge: (text: string) => Promise<Verdict> = async (text) => {
  const q = query({
    prompt: PROMPT + text.slice(0, 12_000),
    options: {
      model: config.models.triage,
      maxTurns: 2,
      tools: [],
      settingSources: [],
      persistSession: false,
      outputFormat: { type: "json_schema", schema: SCHEMA },
      env: Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && k !== "CLAUDE_CODE_OAUTH_TOKEN")) as Record<string, string>,
    },
  });
  for await (const m of q) {
    if (m.type !== "result") continue;
    if (m.subtype !== "success") throw new Error(m.subtype);
    const out = (m.structured_output ?? JSON.parse(m.result)) as { odds?: number; reason?: string };
    const odds = Math.max(0, Math.min(1, Number(out.odds ?? 1)));
    return { act: odds >= THRESHOLD, odds, reason: out.reason ?? "" };
  }
  throw new Error("no result");
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

/** Screens a batch of reports and sends it the cheaper way it can go. */
export async function screen(text: string, sinks: Sinks): Promise<Verdict> {
  let verdict: Verdict;
  try {
    verdict = await judge(text);
  } catch (err) {
    log.warn(`gate failed, turning: ${(err as Error).message}`);
    verdict = { act: true, odds: 1, reason: "gate failed" };
  }
  if (verdict.act) {
    log.info(`turn (${Math.round(verdict.odds * 100)}%): ${verdict.reason}`);
    sinks.turn(text);
    return verdict;
  }
  log.info(`deferred (${Math.round(verdict.odds * 100)}%): ${verdict.reason}`);
  deferred += 1;
  sinks.note(text);
  nudge ??= setTimeout(() => {
    nudge = undefined;
    if (deferred) sinks.turn(NUDGE);
  }, NUDGE_MS);
  return verdict;
}

/** Whether a reply is only the boilerplate pai says when it has nothing to say; the chat log skips it. */
export function boilerplate(text: string): boolean {
  const t = text.replace(/[*_`~()\[\]\s]+/g, " ").trim().toLowerCase();
  return t.length <= 48 && /^(no (response|action|reply) (is )?needed|nothing (to do|needed|for you)|no(thing)? (further|new)( for you)?|done)[.!…]*$/.test(t);
}
