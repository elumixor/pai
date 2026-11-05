import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../core/config.ts";
import * as agents from "./agents.ts";
import * as asks from "./asks.ts";
import * as automations from "./automations.ts";
import * as drafts from "./drafts.ts";
import * as journal from "./journal.ts";
import * as messages from "./messages.ts";
import * as tasks from "./tasks.ts";

/**
 * The state of things as one markdown document: what pai remembers, who its staff are and what each
 * knows, every open task, decision and draft, the routines, the journal and the conversation. Written so that a person can read it, and
 * so that handed to a fresh pai as a prompt, it has enough to check all of it and file what holds in Keep.
 */

/** What pai does with a snapshot: the old state is a lead to check, not a state to restore. Work lives in Keep, not in staff. */
const IMPORT_STEPS = [
  "When the user asks you to import this file, parts of it are out of date, so every line is a lead to check, not a fact. The journal and conversation are history: evidence to read as needed. Rebuild the current picture, in this order:",
  "1. Fact-check. For each claim, open task and decision look at the latest evidence: mail, Telegram, WhatsApp, calendar, Keep, dev, recall, the web. Work out what is done, dead, changed or still true.",
  "2. Memory: rewrite MEMORY.md from what survives the check. Durable facts stay, anything stale goes.",
  "3. Keep: projects, tasks and docs live there. Search first and update what exists; otherwise create pages: a project per area, a task per thing still open, a doc for notes worth keeping.",
  "4. Workers: anything too big for your own context goes to a worker (create_agent), several at once when the work splits. Each writes its results to Keep pages and reports the page. Do not create standing agents, and do not recreate the agents named in the export: their areas become Keep projects.",
  "5. Send nothing as the user. A pending draft or a message that is due becomes a Keep task, or a card for the user (offer_draft).",
  "6. Routines stay as they are, unless the check shows one is useless: then ask.",
  "When done, report in a few lines: what is in Keep now (name the pages), what you dropped as stale, and which decisions are the user's, asked one at a time with ask_user.",
].join("\n");

const readIf = (path: string) => (existsSync(path) ? readFileSync(path, "utf8").trim() : "");
const fence = (text: string) => `\`\`\`markdown\n${text.replace(/```/g, "~~~")}\n\`\`\``;
const line = (label: string, value: string | null | undefined) => (value ? `- ${label}: ${value}` : "");

/** History closes the document, so importing by prompt can leave it out: the whole of it is too much for one turn. */
const HISTORY_HEADING = "## Journal";

/** Everything said in General, oldest first. */
function conversation() {
  const rows: messages.Message[] = [];
  for (let before: number | undefined; ; ) {
    const page = messages.list({ agent: agents.PAI, kinds: ["chat", "ask", "answer"], before, limit: 1000 });
    rows.unshift(...page);
    if (page.length < 1000) return rows;
    before = page[0]!.id;
  }
}
const journalDays = () => (existsSync(journal.dir()) ? readdirSync(journal.dir()).filter((f) => f.endsWith(".md")).sort() : []);

export function snapshot(): string {
  const day = new Date().toISOString().slice(0, 10);
  const memory = readIf(join(config.workspace, "MEMORY.md"));
  const staff = agents.list().filter((a) => a.slug !== agents.PAI);
  const byDepth = [...staff].sort((x, y) => agents.depth(x.slug) - agents.depth(y.slug) || x.name.localeCompare(y.name));
  const open = tasks.list();
  const decisions = asks.open();
  const routines = automations.all();
  const waiting = drafts.open();
  const days = journalDays();
  const said = conversation();

  const agentBlock = (a: agents.Agent) =>
    [
      `### ${a.name} (\`${a.slug}\`)`,
      line("kind", a.kind),
      line("reports to", a.parent && a.parent !== agents.PAI ? a.parent : "pai"),
      a.bubble ? "" : "- bubble: off (keeps the reports it receives)",
      line("project", a.project),
      line("tools", a.tools?.join(", ")),
      line("model", a.model),
      line("effort", a.effort),
      line("budget", `${a.budget.turnsPerDay} turns a day, ${a.budget.turnMinutes} minutes a turn`),
      "",
      "Brief:",
      "",
      fence(a.brief),
      ...(readIf(join(a.folder, "STATE.md")) ? ["", "Notes (STATE.md):", "", fence(readIf(join(a.folder, "STATE.md")))] : []),
    ]
      .filter((l) => l !== "")
      .join("\n");

  const taskLine = (t: tasks.Task) => `- #${t.id} **${t.title}** — ${t.owner === agents.PAI ? "pai" : t.owner}, ${t.status.replace("_", " ")}${t.due ? `, due ${t.due}` : ""}${t.nextAction ? `\n  next: ${t.nextAction}` : ""}${t.source ? `\n  source: ${t.source}` : ""}${t.notes ? `\n  notes: ${t.notes.replace(/\n+/g, " ")}` : ""}`;
  const askLine = (a: asks.Ask) => `- #${a.id} from ${a.agent}: ${a.question}${a.options.length ? ` [${a.options.join(" / ")}]` : ""}`;
  const routineLine = (r: automations.Automation) => `- **${r.name}**: ${r.schedule ? `cron \`${r.schedule}\`` : `on \`${r.event}\``}${r.filter ? ` (filter: ${r.filter})` : ""} → ${r.action}${r.agent ? ` ${r.agent}` : ""}${r.template ? `: ${r.template.replace(/\n+/g, " ")}` : ""}${r.enabled ? "" : " (off)"}`;

  return [
    `# pai snapshot — ${day}`,
    "",
    "The state of things in one document: memory, staff, tasks, decisions, drafts, routines, then the journal and the conversation.",
    "",
    "## How to import",
    "",
    IMPORT_STEPS,
    "",
    "## Memory (MEMORY.md)",
    "",
    memory ? fence(memory) : "_empty_",
    "",
    `## Staff (${byDepth.length})`,
    "",
    byDepth.length ? byDepth.map(agentBlock).join("\n\n") : "_no agents_",
    "",
    `## Open tasks (${open.length})`,
    "",
    open.length ? open.map(taskLine).join("\n") : "_none_",
    "",
    `## Decisions waiting on the user (${decisions.length})`,
    "",
    decisions.length ? decisions.map(askLine).join("\n") : "_none_",
    "",
    `## Pending drafts (${waiting.length})`,
    "",
    waiting.length ? waiting.map((d) => `### #${d.id}, ${d.channel}, by ${d.agent}\n\n${fence(drafts.asText(d))}`).join("\n\n") : "_none_",
    "",
    `## Routines (${routines.length})`,
    "",
    routines.length ? routines.map(routineLine).join("\n") : "_none_",
    "",
    HISTORY_HEADING,
    "",
    days.length ? days.map((f) => `### ${f.slice(0, -3)}\n\n${fence(journal.read(f.slice(0, -3)).trim())}`).join("\n\n") : "_empty_",
    "",
    `## Conversation (${said.length})`,
    "",
    said.length ? said.map((m) => `**${m.from}**, ${new Date(m.createdAt).toISOString().slice(0, 16).replace("T", " ")}:\n\n${fence(m.body)}`).join("\n\n") : "_empty_",
    "",
  ].join("\n");
}

/** A snapshot carries these itself, so one attached to a chat with "import this" gets the same treatment. */
export const importPrompt = (text: string) => {
  const state = text.split(`\n${HISTORY_HEADING}\n`)[0]!;
  return `[snapshot import] Follow How to import in this export.${text.includes("## How to import") ? "" : `\n\n${IMPORT_STEPS}`}\n\n${state}`;
};
