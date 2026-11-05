import { now } from "../core/db.ts";
import * as agents from "./agents.ts";
import * as asks from "./asks.ts";
import * as drafts from "./drafts.ts";
import * as held from "./held.ts";
import * as sessions from "./sessions.ts";
import * as tasks from "./tasks.ts";

/** A paused agent's two one-tap ways out; anything else typed is said to it. */
export const RESUME = "Resume";
export const KILL = "Kill";

/**
 * Everything that waits on the user, newest first, in one shape: the questions that reached them, the questions sessions
 * have open (pai's AskUserQuestion), drafts, tasks, and the agents they stopped without a word. A need sits on its area:
 * the agent that asked, or for pai's own asks the owner of the task it is about.
 */
export function needs() {
  const area = (slug: string | undefined) => (slug && slug !== agents.PAI ? slug : null);
  const open = asks.open();
  // An ask held for quiet hours has no row in the chat yet, and one a supervisor holds is not theirs yet: neither is a need.
  const fromAsks = open
    .filter((a) => a.delivered && a.holder === null)
    .map((a) => ({
      kind: "ask" as const,
      id: `ask:${a.id}`,
      askId: a.id,
      taskId: a.taskId ?? undefined,
      agent: area(a.agent === agents.PAI && a.taskId ? tasks.get(a.taskId)?.owner : a.agent),
      from: agents.get(a.agent)?.name ?? a.agent,
      question: a.question,
      options: a.options,
      freeText: a.freeText,
      priority: a.priority,
      // A card that sends them somewhere: `link` is what a client that only knows that one draws, `actions` all of them.
      link: a.actions[0]?.url ?? tasks.firstUrl(a.question, a.context),
      actions: a.actions.map(({ label, url }) => ({ label, url })),
      createdAt: a.createdAt,
    }));
  const fromSessions = sessions.list().flatMap((summary) => {
    const s = sessions.find(summary.sessionId);
    const index = s?.nextUnanswered();
    const q = index === undefined ? undefined : s!.pending!.questions[index];
    if (!s || !q) return [];
    const owner = summary.agent ? agents.get(summary.agent) : undefined;
    return [
      {
        kind: "question" as const,
        id: `q:${s.id}:${s.pending!.id}:${index}`,
        session: s.id,
        agent: owner?.slug ?? null,
        from: owner?.name ?? summary.title,
        question: q.question,
        options: q.options.map((o) => o.label),
        freeText: true,
        priority: "normal",
        link: tasks.firstUrl(q.question),
        createdAt: summary.lastActivity,
      },
    ];
  });
  // A terminal's open question, unless the daemon has since taken that conversation over.
  const fromTerminals = held.all().flatMap((t) => {
    const index = t.question?.questions.findIndex((_, i) => t.question!.answers[i] === undefined) ?? -1;
    const q = t.question?.questions[index];
    if (!q || sessions.find(t.id)) return [];
    return [
      {
        kind: "question" as const,
        id: `q:${t.id}:${t.question!.id}:${index}`,
        session: t.id,
        agent: null,
        from: t.title,
        question: q.question,
        options: q.options.map((o) => o.label),
        freeText: true,
        priority: "normal",
        link: tasks.firstUrl(q.question),
        createdAt: now(),
      },
    ];
  });
  // A draft waiting on them is a decision with a card of its own: Send or Discard, after editing.
  const fromDrafts = drafts.open().map((d) => ({
    kind: "draft" as const,
    id: `draft:${d.id}`,
    draftId: d.id,
    taskId: d.taskId ?? undefined,
    agent: area(d.agent),
    from: agents.get(d.agent)?.name ?? d.agent,
    question: `${drafts.labelFor(d.channel)}${d.fields.to ? ` to ${d.fields.to}` : ""}${d.fields.subject ? `: ${d.fields.subject}` : ""}`,
    options: d.status === "sending" ? [] : ["Send", "Discard"],
    freeText: false,
    priority: "normal",
    draft: { channel: d.channel, fields: d.fields, status: d.status, state: d.state, note: d.note },
    createdAt: d.createdAt,
  }));
  // A task waiting on the user is a decision too: done, dropped, or a word to whoever owns it.
  // A task with an open ask on it is that ask's card already.
  const asked = new Set(open.map((a) => a.taskId));
  const fromTasks = tasks
    .list({ status: "waiting_user" })
    .filter((t) => !asked.has(t.id))
    .map((t) => ({
      kind: "task" as const,
      id: `task:${t.id}`,
      taskId: t.id,
      agent: area(t.owner),
      from: agents.get(t.owner)?.name ?? t.owner,
      question: t.nextAction ? `${t.title}\n${t.nextAction}` : t.title,
      options: [asks.TASK_DID, asks.TASK_SKIP],
      freeText: true,
      priority: "normal",
      link: tasks.firstUrl(t.nextAction, t.source, t.notes),
      createdAt: t.updatedAt,
    }));
  // Stopped by the user, who said nothing yet: it waits on them for instructions.
  const fromPaused = agents
    .list()
    .filter((a) => a.status === "paused")
    .map((a) => ({
      kind: "paused" as const,
      id: `paused:${a.slug}`,
      agent: a.slug,
      from: a.name,
      question: `You stopped ${a.name}${a.pauseReason ? `: ${a.pauseReason}` : ""}. It is waiting for you.`,
      options: [RESUME, KILL],
      freeText: true,
      priority: "normal",
      createdAt: a.pausedAt ?? a.lastActive,
    }));
  return [...fromSessions, ...fromTerminals, ...fromPaused, ...fromDrafts, ...fromAsks, ...fromTasks].sort((a, b) => b.createdAt - a.createdAt);
}
