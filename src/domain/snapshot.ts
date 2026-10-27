import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../core/config.ts";
import * as agents from "./agents.ts";
import * as asks from "./asks.ts";
import * as automations from "./automations.ts";
import { all as allProjects } from "./projects.ts";
import * as tasks from "./tasks.ts";

/**
 * The state of things as one markdown document: what pai remembers, who its staff are and what each
 * knows, every open task and decision, the routines, the projects pai keeps context for. Written so
 * that a person can read it — and so that handed to a fresh pai as a prompt, it has enough to
 * rebuild all of it: the agents with their briefs and notes, the tasks, the memory.
 */

const readIf = (path: string) => (existsSync(path) ? readFileSync(path, "utf8").trim() : "");
const fence = (text: string) => `\`\`\`markdown\n${text.replace(/```/g, "~~~")}\n\`\`\``;
const line = (label: string, value: string | null | undefined) => (value ? `- ${label}: ${value}` : "");

export function snapshot(): string {
  const day = new Date().toISOString().slice(0, 10);
  const memory = readIf(join(config.workspace, "MEMORY.md"));
  const staff = agents.list().filter((a) => a.slug !== agents.PAI);
  const byDepth = [...staff].sort((x, y) => agents.depth(x.slug) - agents.depth(y.slug) || x.name.localeCompare(y.name));
  const open = tasks.list();
  const decisions = asks.open();
  const routines = automations.all();
  const contexts = allProjects().filter((p) => p.kind === "context");

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
    "The state of things in one document: memory, staff, tasks, decisions, routines, projects. Handed to pai as a prompt, it rebuilds them: create the agents that are missing (with these briefs, parents, tools), write each one's STATE.md from its notes, add the tasks that are not there, put the memory into MEMORY.md.",
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
    `## Routines (${routines.length})`,
    "",
    routines.length ? routines.map(routineLine).join("\n") : "_none_",
    "",
    `## Project contexts (${contexts.length})`,
    "",
    contexts.length ? contexts.map((p) => [`### ${p.slug}`, p.summary, "", fence(readIf(join(p.path, "CLAUDE.md")))].join("\n")).join("\n\n") : "_none_",
    "",
  ].join("\n");
}

/** What pai is told with a snapshot: rebuild what is in it, change nothing that is not. */
export const importPrompt = (text: string) =>
  [
    "[snapshot import] Below is a snapshot of the state of things, exported from a pai. Bring this one into line with it, in this order:",
    "1. Memory: merge its MEMORY.md section into MEMORY.md (keep what is here and not there; take what is there and not here; where they differ, the snapshot wins).",
    "2. Staff: for each agent, create it if no agent with that slug or name exists (create_agent with the kind, parent, brief, tools, model, project), else configure it to match; then write its STATE.md from its notes (Write the file in its folder under workspace/agents/<slug>/).",
    "3. Tasks: add the ones not here (task_add with the owner, status, due, next action, notes); leave the ones already here alone.",
    "4. Routines and project contexts: create what is missing (routine_add; a context with the project tools you have).",
    "Do not delete or close anything the snapshot does not mention. When done, report in a few lines what was created, what was updated and what was already in place.",
    "",
    text,
  ].join("\n");
