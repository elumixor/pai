import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../core/config.ts";
import { logger } from "../core/log.ts";
import * as agentPage from "./agent-page.ts";
import { connectUrl } from "./ask-actions.ts";
import * as agents from "./agents.ts";
import * as automations from "./automations.ts";
import { chatConfig } from "./context.ts";
import { eventCatalog } from "./event-catalog.ts";
import * as journal from "./journal.ts";

/** What one agent runs on, General included, for the sheet its chat opens: told what, remembers what, tracked where, can do what, woken by what. */

const log = logger("agent-sheet");

const readIf = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");

function memoryOf(a: agents.Agent) {
  if (a.kind !== "orchestrator") return [{ name: "STATE.md", text: readIf(join(a.folder, "STATE.md")) }];
  const today = journal.logicalDay();
  return [
    { name: "MEMORY.md", text: readIf(join(config.workspace, "MEMORY.md")) },
    { name: `Journal ${today}`, text: journal.read(today) },
  ];
}

export async function agentSheet(a: agents.Agent) {
  const general = a.kind === "orchestrator";
  const { who, instructions, tools } = chatConfig(general ? "general" : "worker", a.tools ?? undefined);
  const [page, keep, assigned] = await Promise.all([
    a.keepPage && !general
      ? agentPage.shown(a.keepPage).catch((err: Error) => {
          log.warn(`${a.slug}: ${err.message}`);
          return { urn: a.keepPage, error: err.message };
        })
      : null,
    agentPage.workspaces().catch((err: Error) => {
      log.warn(`workspaces: ${err.message}`);
      return { workspaces: [], shared: [], error: err.message };
    }),
    general
      ? agentPage.assigned().catch((err: Error) => {
          log.warn(`assigned: ${err.message}`);
          return [];
        })
      : [],
  ]);
  return {
    agent: a,
    who,
    breadcrumb: agents.breadcrumb(a.slug),
    instructions: { ...agents.instructionsOf(a), sections: instructions },
    memory: memoryOf(a),
    page,
    keep,
    assigned,
    connectUrl: general ? connectUrl() : undefined,
    tools,
    routines: automations.all().filter((r) => (r.agent ? r.agent === a.slug : general)),
    events: eventCatalog(),
  };
}
