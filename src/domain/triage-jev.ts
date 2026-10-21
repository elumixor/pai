import { logger } from "../core/log.ts";
import * as agents from "./agents.ts";
import * as decide from "./decide.ts";
import * as tasks from "./tasks.ts";
import type { Decision, Item } from "./triage.ts";

const log = logger("triage");

/**
 * Triage on the decision model instead of a small LLM: each item is one call with a few typed
 * questions — the action, which agent owns it, which open task it belongs to, whether it is
 * urgent — and code combines the answers. A choice
 * leans to its first option, so "none" goes first everywhere: an item has to earn an owner.
 */

/** Below this an owner or a task is not trusted and the item is filed under pai instead. */
const OWNER_AT = 0.5;
const MAX_TASKS = 60;
const CONCURRENCY = 6;

const ACTION: decide.Choice = {
  type: "choice",
  instructions: "What should happen with `item` now?",
  criteria: {
    ignore: "A newsletter, notification, receipt, promotion, automated mail, spam, or group chatter nobody has to act on",
    file: "Worth keeping on the task list, but nobody has to act now",
    wake: "The agent that owns this area should act on it now",
    tell: "The user should know now: a person writing to them personally, or something time-sensitive",
  },
};
const URGENT: decide.Noul = { type: "noul", instructions: "The user has only minutes to act on `item`.", criteria: { true: "A deadline, meeting or request that expires within the hour", false: "Can wait a few hours or more" } };

const pct = (n: number) => `${Math.round(n * 100)}%`;

export async function decideItems(items: Item[]): Promise<Decision[]> {
  const staff = agents.list().filter((a) => a.kind === "standing");
  const open = tasks.list({ limit: MAX_TASKS });
  const agentQ: decide.Choice | undefined = staff.length
    ? { type: "choice", instructions: "Which agent's area is `item` about?", criteria: { none: "None of them, or not clearly any one of them", ...Object.fromEntries(staff.map((a) => [a.slug, `${a.name}: ${a.brief.split("\n")[0]!.slice(0, 160)}`])) } }
    : undefined;
  const taskQ: decide.Choice | undefined = open.length
    ? { type: "choice", instructions: "Which open task is `item` about?", criteria: { none: "None of the listed tasks", ...Object.fromEntries(open.map((t) => [`t${t.id}`, t.title.slice(0, 120)])) } }
    : undefined;
  const out: Decision[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await one(i, items[i]!, agentQ, taskQ);
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  return out;
}

async function one(i: number, item: Item, agentQ?: decide.Choice, taskQ?: decide.Choice): Promise<Decision> {
  const p = item.payload as { out?: boolean; mentioned?: boolean };
  const state = { item: { source: item.source, title: item.title, body: item.body.replace(/\s+/g, " ").slice(0, 2000), written_by_the_user: Boolean(p.out), user_addressed: Boolean(p.mentioned) } };
  const a = await decide.ask(state, { action: ACTION, urgent: URGENT, ...(agentQ ? { agent: agentQ } : {}), ...(taskQ ? { task: taskQ } : {}) });
  const act = a.action.choice as Decision["action"];
  const owner = a.agent && a.agent.choice !== "none" && a.agent.probabilities[a.agent.choice]! >= OWNER_AT ? a.agent.choice : undefined;
  const task = a.task && a.task.choice !== "none" && a.task.probabilities[a.task.choice]! >= OWNER_AT ? Number(a.task.choice.slice(1)) : undefined;
  const reason = `${act} ${pct(a.action.probabilities[act] ?? 0)}${owner ? ` · ${owner} ${pct(a.agent!.probabilities[owner]!)}` : ""}${task ? ` · #${task} ${pct(a.task!.probabilities[`t${task}`]!)}` : ""}`;
  log.debug(`[${i}] ${reason}: ${item.title}`);
  // The user's own message is never news to the user; it goes on the task list and to its owner.
  if (act === "tell" && p.out) return owner ? { i, action: "wake", agent: owner, task, reason } : { i, action: "file", task, title: item.title, owner: undefined, reason };
  if (act === "ignore") return { i, action: "ignore", reason };
  if (act === "wake") return owner ? { i, action: "wake", agent: owner, task, reason } : { i, action: "file", task, title: item.title, owner: undefined, reason };
  if (act === "tell") return { i, action: "tell", note: item.title, urgent: a.urgent.noul >= 0.7, reason };
  return { i, action: "file", task, title: item.title, owner, reason };
}
