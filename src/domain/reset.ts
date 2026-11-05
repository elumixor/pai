import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bus } from "../core/bus.ts";
import { config } from "../core/config.ts";
import { db, kv } from "../core/db.ts";
import { logger } from "../core/log.ts";
import * as agents from "./agents.ts";
import * as main from "./main.ts";
import * as sessions from "./sessions.ts";
import { projectsDir } from "./transcript.ts";

const log = logger("reset");

const WIPED_TABLES = ["tasks", "messages", "asks", "notices", "requests", "routes", "drafts", "inbox"] as const;
const WIPED_KEYS = ["agent_queue", "agent_held", "main_limit_held", "main_last_user", "main_thread_id", "read_marks"] as const;
const WIPED_FOLDERS = ["agents", "journal", "drafts"] as const;
const BLANK_MEMORY = "# Profile\n";

/** What a blank pai is told first. Hidden from the chat, which opens on whatever pai asks. */
const EXPLORE = `[fresh start] You know nothing about the user yet: this chat, your memory and your journal were cleared on their request. Build the picture of who they are, what they are working on and what they want, starting now. Hand anything big to workers.

Look through:
- Keep, every workspace you can reach (keep, keep-amcz, keep-atma, keep-desk): projects, docs and tasks.
- dev's repositories, mail, calendar, Balance, Telegram, WhatsApp, Drive, Notion, their Claude Code conversations, their claude.ai chats (claude.ai refuses the box, so workspace/inbox/claude-chats holds a copy, one JSON file per chat: grep it), and workspace/people.

While you do:
- Write durable facts to MEMORY.md once confirmed. A guess is not a fact: mark it as a guess or ask.
- When you are not sure, ask, one question at a time with one-tap options, the most useful first. Ask from what you found, never what you could look up.
- For the tasks in Keep, ask which are still relevant, grouped so it is not one question per task.
- Send nothing as the user, and change nothing in Keep until they have answered.

Finish with a short summary: who they are, what is active, what is still unknown.`;

export class ResetError extends Error {}

let resetting = false;

/** Every session that belongs to General: pai's own, its workers', and the threads those workers started. */
function generalSessions() {
  const rows = db.query("SELECT session_id, agent, parent_id, thread_id FROM sessions").all() as { session_id: string; agent: string | null; parent_id: string | null; thread_id: number | null }[];
  const gone = new Set(rows.filter((r) => r.agent).map((r) => r.session_id));
  const workers = new Set(rows.filter((r) => r.agent && r.agent !== agents.PAI).map((r) => r.session_id));
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of rows) {
      if (!r.parent_id || !workers.has(r.parent_id) || workers.has(r.session_id)) continue;
      workers.add(r.session_id);
      gone.add(r.session_id);
      grew = true;
    }
  }
  return { rows, gone };
}

function deleteTranscripts(ids: ReadonlySet<string>) {
  if (!existsSync(projectsDir)) return;
  for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = entry.name;
    const path = join(projectsDir, dir);
    if (dir.includes("-workspace-agents")) {
      rmSync(path, { recursive: true, force: true });
      continue;
    }
    for (const id of ids) for (const file of [`${id}.jsonl`, id]) rmSync(join(path, file), { recursive: true, force: true });
  }
}

/**
 * Clears General for good: its conversation, memory, journal, tasks and workers, in the database and on disk. Plain
 * threads, Keep, people's notes, routines and connectors stay. There is no undo: export a snapshot first if it matters.
 */
export function clearGeneral() {
  if (resetting) throw new ResetError("a reset is already running");
  resetting = true;
  try {
    const { rows, gone } = generalSessions();
    const topics = [...new Set([main.thread(), ...rows.filter((r) => gone.has(r.session_id)).map((r) => r.thread_id), ...agents.list({ closed: true }).map((a) => a.threadId)])].filter((t): t is number => Boolean(t));
    agents.forgetAll();
    sessions.erase(gone);
    db.transaction(() => {
      const refs = db.prepare("DELETE FROM archive WHERE source = 'transcript' AND ref = ?");
      for (const id of gone) refs.run(id);
      db.exec("DELETE FROM archive WHERE source = 'message'");
      for (const r of rows) if (r.parent_id && gone.has(r.parent_id) && !gone.has(r.session_id)) db.prepare("UPDATE sessions SET parent_id = NULL WHERE session_id = ?").run(r.session_id);
      db.prepare("DELETE FROM agents WHERE slug != ?").run(agents.PAI);
      db.prepare("UPDATE agents SET session_id = NULL, status = 'idle', turns_today = 0, card_id = NULL WHERE slug = ?").run(agents.PAI);
      for (const table of WIPED_TABLES) db.exec(`DELETE FROM ${table}`);
      const placeholders = gone.size ? [...gone].map(() => "?").join(",") : "''";
      db.prepare(`DELETE FROM tg_messages WHERE session_id IN (${placeholders})`).run(...gone);
    })();
    for (const key of WIPED_KEYS) kv.del(key);
    deleteTranscripts(gone);
    for (const folder of WIPED_FOLDERS) for (const name of existsSync(join(config.workspace, folder)) ? readdirSync(join(config.workspace, folder)) : []) rmSync(join(config.workspace, folder, name), { recursive: true, force: true });
    writeFileSync(join(config.workspace, "MEMORY.md"), BLANK_MEMORY);
    log.info(`General reset: ${gone.size} sessions, ${topics.length} topics`);
    bus.emitEvent("main.reset", { topics });
  } finally {
    resetting = false;
  }
}

/** Clears General, then pai starts over on a hidden turn, so the chat opens empty. */
export function resetGeneral() {
  clearGeneral();
  main.silent(EXPLORE);
}
