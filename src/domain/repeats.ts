import { logger } from "../core/log.ts";
import * as asks from "./asks.ts";
import * as decide from "./decide.ts";
import * as tasks from "./tasks.ts";

const log = logger("repeats");

/**
 * The same decision asked twice in other words: "LFS quota is full, fix it how?" and a task
 * "LFS at 100%, buy a pack or prune" share almost no words, so a word match cannot see it. The
 * decision model reads the new question against everything already waiting on the user and names
 * the one it repeats, if any. It fails open: no key, an error or a doubt lets the ask through.
 */

/** A repeat is named only at this probability or above. */
export const SAME_AT = 0.8;

export type Repeat = { readonly kind: "ask"; readonly ask: asks.Ask } | { readonly kind: "task"; readonly task: tasks.Task };

/** What the question would repeat among the open asks and the tasks waiting on the user, the task it is about aside. */
export async function repeatOf(question: string, taskId?: number): Promise<Repeat | undefined> {
  if (!decide.enabled()) return undefined;
  const open = asks.open().filter((a) => !taskId || a.taskId !== taskId);
  const waiting = tasks.list({ status: "waiting_user" }).filter((t) => t.id !== taskId && !open.some((a) => a.taskId === t.id));
  if (!open.length && !waiting.length) return undefined;
  const criteria: Record<string, string | null> = { none: "None of them: a different decision" };
  for (const a of open) criteria[`a${a.id}`] = a.question.slice(0, 300);
  for (const t of waiting) criteria[`t${t.id}`] = `${t.title}${t.nextAction ? ` — ${t.nextAction}` : ""}`.slice(0, 300);
  try {
    const { same } = await decide.ask(
      { question },
      { same: { type: "choice", instructions: "Which decision already waiting on the user is the same decision as `question`, asked again in other words?", criteria } as const },
    );
    if (same.choice === "none" || decide.probability(same, same.choice) < SAME_AT) return undefined;
    const id = Number(same.choice.slice(1));
    if (same.choice.startsWith("a")) {
      const ask = open.find((a) => a.id === id);
      return ask && { kind: "ask", ask };
    }
    const task = waiting.find((t) => t.id === id);
    return task && { kind: "task", task };
  } catch (err) {
    log.warn(`repeat check failed, asking: ${(err as Error).message}`);
    return undefined;
  }
}
