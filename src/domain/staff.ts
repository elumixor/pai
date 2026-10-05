import { kv } from "../core/db.ts";
import { logger } from "../core/log.ts";
import * as agents from "./agents.ts";
import * as automations from "./automations.ts";

const log = logger("staff");

/**
 * The agents pai starts with, made once: Voice (the first service agent), and the first two
 * standing agents, Hiring and Job search. They sit idle until woken; pai creates the rest as
 * areas come up.
 */

const SEEDED = "staff_seeded";

export function seed() {
  if (kv.get(SEEDED)) return;
  try {
    const have = (name: string) => agents.list({ closed: true }).some((a) => a.name === name);
    if (!have("Voice"))
      agents.create({
        name: "Voice",
        kind: "service",
        model: "opus",
        tools: ["telegram", "gmail"],
        brief: `Rewrite drafts so they read as if the user wrote them: their tone, their length, their words. You answer requests like "rewrite in the user's voice" or "review in the user's voice"; your whole reply is the rewritten text and nothing else.

How the user writes: load the writing-style skill and follow it. Keep samples of messages the user actually sent (their own Telegram and email, found with the telegram and gmail tools) in samples.md in your folder, a few per kind of message (a reply to a candidate, a note to the team, a message to family), and refresh them when you have nothing on file for a kind.

Never change facts, names, numbers, dates or commitments in a draft; only how it is said. Keep the language the draft is in.`,
      });
    if (!have("Hiring"))
      agents.create({
        name: "Hiring",
        kind: "standing",
        model: "opus",
        tools: ["linkedin", "gmail", "calendar", "balance", "notion", "playwright", "browser", "telegram"],
        brief: `Hire people for Hypocrisy (Atma Gaming's game): job posts, finding and screening candidates, replying to them, scheduling calls, onboarding each hire.

- One task per open role, one sub-task per candidate in play (with the candidate's name and their LinkedIn or email in the task, so a new message from them can be matched).
- Replies to candidates go through pai: request "approve outbound message" with the final draft; send only what comes back approved, then log it against the candidate's task.
- Start sub-agents for bounded jobs: a post writer, a profile screener, a reply drafter, an onboarding agent per hire.
- People files: one per candidate under the workspace's people/ folder.
- Team pages in Notion are for reading; your notes stay in your folder, not in Notion.`,
      });
    if (!have("Job search"))
      agents.create({
        name: "Job search",
        kind: "standing",
        model: "opus",
        tools: ["playwright", "browser", "linkedin", "gmail", "drive"],
        brief: `Find the user a better job: market research, saved searches, new postings worth a look, the CV, one application at a time, replies from recruiters.

- Keep saved searches in your folder (searches.md) and what you have already seen (seen.md), so the daily look only brings up what is new.
- One task per application, with the posting's link and where it stands.
- Applications, messages to recruiters and anything sent as the user go through pai: request "approve outbound message" with the final text.
- Start sub-agents for market research, the CV, and one applicant per application.`,
      });
    const hiring = agents.list().find((a) => a.name === "Hiring");
    const jobs = agents.list().find((a) => a.name === "Job search");
    const routines = automations.all();
    if (hiring && !routines.some((r) => r.name === "Candidate replies"))
      automations.create({ name: "Candidate replies", event: "linkedin.message", check: { matches_open_task: "with" }, action: "wake", agent: hiring.slug, owner: hiring.slug, template: "New LinkedIn message from {with}:\n{text}\n{url}" });
    if (jobs && !routines.some((r) => r.name === "Job postings"))
      automations.create({ name: "Job postings", schedule: "0 8 * * *", action: "wake", agent: jobs.slug, owner: jobs.slug, template: "Daily look: new postings for the saved searches since yesterday. Report only what is worth the user's time." });
    kv.set(SEEDED, new Date().toISOString());
    log.info("seeded Voice, Hiring, Job search");
  } catch (err) {
    log.warn(`seeding staff: ${(err as Error).message}`);
  }
}
