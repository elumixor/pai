import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.ts";

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath, { create: true });
db.exec("PRAGMA journal_mode = WAL;");
// Another process on the same file (a test run, the CLI) holds the write lock for moments,
// not seconds; waiting is right, failing the daemon's turn with SQLITE_BUSY is not.
db.exec("PRAGMA busy_timeout = 5000;");

db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  slug        TEXT PRIMARY KEY,
  path        TEXT NOT NULL,
  summary     TEXT NOT NULL DEFAULT '',
  aliases     TEXT NOT NULL DEFAULT '[]',
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id    TEXT PRIMARY KEY,
  short_id      TEXT NOT NULL,
  kind          TEXT NOT NULL,            -- main | task | code
  title         TEXT NOT NULL DEFAULT '',
  cwd           TEXT NOT NULL,
  project       TEXT,
  thread_id     INTEGER,                  -- telegram topic this session lives in
  card_id       INTEGER,                  -- telegram message that shows live status
  state         TEXT NOT NULL,            -- starting | idle | busy | dead
  started_at    INTEGER NOT NULL,
  last_activity INTEGER NOT NULL,
  last_result   TEXT,
  cost_usd      REAL NOT NULL DEFAULT 0,
  turns         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT,
  kind        TEXT NOT NULL,
  payload     TEXT NOT NULL,
  ts          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_session ON events(session_id, id);

-- Maps an outbound telegram message back to the session that produced it,
-- so a reply routes deterministically without asking the model.
CREATE TABLE IF NOT EXISTS tg_messages (
  message_id  INTEGER PRIMARY KEY,
  session_id  TEXT NOT NULL,
  ts          INTEGER NOT NULL
);

-- on <event> -> <action>; see domain/automations.ts
CREATE TABLE IF NOT EXISTS automations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  event       TEXT NOT NULL,
  filter      TEXT NOT NULL DEFAULT '',
  action      TEXT NOT NULL,
  project     TEXT NOT NULL DEFAULT '',
  template    TEXT NOT NULL DEFAULT '',
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  runs        INTEGER NOT NULL DEFAULT 0,
  last_run    INTEGER
);

CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- How far each transcript has been read by the mirror (domain/mirror.ts), so a restart does not repeat it.
CREATE TABLE IF NOT EXISTS transcript_offsets (
  path    TEXT PRIMARY KEY,
  offset  INTEGER NOT NULL
);

-- pai and its staff: the orchestrator, standing agents, sub-agents, service agents; see domain/agents.ts.
CREATE TABLE IF NOT EXISTS agents (
  slug         TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL,             -- orchestrator | standing | sub | service
  parent       TEXT,                      -- who it reports to; null only for pai
  brief        TEXT NOT NULL DEFAULT '',
  folder       TEXT NOT NULL,
  project      TEXT,                      -- a repo it works in (a coding agent), else its folder is its cwd
  tools        TEXT,                      -- JSON list of MCP server names it may use; null = all
  model        TEXT,
  effort       TEXT,
  budget       TEXT NOT NULL DEFAULT '{}',-- {"turnsPerDay": n, "turnMinutes": n}
  priority     INTEGER NOT NULL DEFAULT 0,-- shifts its notices up or down a level
  status       TEXT NOT NULL,             -- idle | queued | working | waiting | closed
  session_id   TEXT,
  thread_id    INTEGER,                   -- its forum topic in the plain bot
  card_id      INTEGER,                   -- the delegation card in the parent's chat
  turns_day    TEXT NOT NULL DEFAULT '',
  turns_today  INTEGER NOT NULL DEFAULT 0,
  cost_usd     REAL NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  last_active  INTEGER NOT NULL,
  closed_at    INTEGER
);

-- The one task list; see domain/tasks.ts.
CREATE TABLE IF NOT EXISTS tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT NOT NULL,
  parent_id    INTEGER,
  owner        TEXT NOT NULL DEFAULT 'pai',
  status       TEXT NOT NULL DEFAULT 'inbox',
  next_action  TEXT NOT NULL DEFAULT '',
  due          TEXT,
  source       TEXT,
  notes        TEXT NOT NULL DEFAULT '',
  created_by   TEXT NOT NULL DEFAULT 'pai',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_owner ON tasks(owner, status);

-- Every word between the user, pai, agents, routines and watchers; see domain/messages.ts.
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sender      TEXT NOT NULL,
  recipient   TEXT NOT NULL,
  kind        TEXT NOT NULL,
  body        TEXT NOT NULL,
  task_id     INTEGER,
  meta        TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_sender ON messages(sender, id);
CREATE INDEX IF NOT EXISTS messages_recipient ON messages(recipient, id);

-- An agent's need routed through pai; routes remember who answered a need before.
CREATE TABLE IF NOT EXISTS requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  requester    TEXT NOT NULL,
  need         TEXT NOT NULL,
  payload      TEXT NOT NULL,
  reply_to_me  INTEGER NOT NULL DEFAULT 1,
  handler      TEXT,
  status       TEXT NOT NULL DEFAULT 'open',  -- open | forwarded | answered | failed
  response     TEXT,
  created_at   INTEGER NOT NULL,
  answered_at  INTEGER
);
CREATE TABLE IF NOT EXISTS routes (
  need        TEXT PRIMARY KEY,
  agent       TEXT NOT NULL,
  uses        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

-- Questions for the user from agents; see domain/asks.ts.
CREATE TABLE IF NOT EXISTS drafts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent       TEXT NOT NULL,                   -- who wrote it and who will send it
  channel     TEXT NOT NULL,                   -- email | telegram | whatsapp | linkedin | post
  fields      TEXT NOT NULL DEFAULT '{}',      -- to, cc, subject, body / text: what the channel has
  status      TEXT NOT NULL DEFAULT 'pending', -- pending | sending | sent | failed | dropped
  state       TEXT,                            -- verified | unverified | not_sent, once it has gone
  note        TEXT NOT NULL DEFAULT '',
  task_id     INTEGER,
  message_id  INTEGER,                         -- its row in the chat, which draws the card
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS asks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent       TEXT NOT NULL,
  question    TEXT NOT NULL,
  options     TEXT NOT NULL DEFAULT '[]',
  free_text   INTEGER NOT NULL DEFAULT 1,
  priority    TEXT NOT NULL DEFAULT 'normal',
  blocking    INTEGER NOT NULL DEFAULT 1,
  fallback    TEXT,
  context     TEXT NOT NULL DEFAULT '',
  task_id     INTEGER,
  status      TEXT NOT NULL DEFAULT 'open',   -- open | answered | dropped
  answer      TEXT,
  message_id  INTEGER,
  created_at  INTEGER NOT NULL,
  answered_at INTEGER
);

-- Notices waiting for quiet hours to end or for the next brief.
CREATE TABLE IF NOT EXISTS notices (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  agent        TEXT NOT NULL,
  text         TEXT NOT NULL,
  priority     TEXT NOT NULL,                 -- urgent | normal | digest | log
  created_at   INTEGER NOT NULL,
  delivered_at INTEGER
);

-- What the user said to always ask about or always let through, per outbound action type.
CREATE TABLE IF NOT EXISTS pins (
  action      TEXT PRIMARY KEY,
  mode        TEXT NOT NULL,                  -- ask | auto
  created_at  INTEGER NOT NULL
);

-- "Stop telling me about newsletters": triage ignores what matches.
CREATE TABLE IF NOT EXISTS mutes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern     TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);

-- Where each watcher left off, so nothing fires twice.
CREATE TABLE IF NOT EXISTS cursors (
  source      TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Transcripts, the message log, mail and chat copies, searched with the recall tool; see domain/recall.ts.
CREATE VIRTUAL TABLE IF NOT EXISTS archive USING fts5(source, ref UNINDEXED, title, body, ts UNINDEXED, tokenize = 'porter unicode61');
`);

// Columns added after the first release; ALTER is the migration.
if (!(db.query("PRAGMA table_info(projects)").all() as { name: string }[]).some((c) => c.name === "kind"))
  db.exec("ALTER TABLE projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'repo'");
const sessionColumns = (db.query("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name);
if (!sessionColumns.includes("parent_id")) db.exec("ALTER TABLE sessions ADD COLUMN parent_id TEXT");
if (!sessionColumns.includes("model")) db.exec("ALTER TABLE sessions ADD COLUMN model TEXT");
// What a session was told to run with, as opposed to `model`, which is what answered.
if (!sessionColumns.includes("model_pref")) db.exec("ALTER TABLE sessions ADD COLUMN model_pref TEXT");
if (!sessionColumns.includes("effort")) db.exec("ALTER TABLE sessions ADD COLUMN effort TEXT");
// The agent a session works for (pai itself, or one of its staff); null for plain threads.
if (!sessionColumns.includes("agent")) db.exec("ALTER TABLE sessions ADD COLUMN agent TEXT");
// Where a thread was started: general (the client, detached), cli, terminal, phone, builder, routine; null = not recorded.
if (!sessionColumns.includes("origin")) {
  db.exec("ALTER TABLE sessions ADD COLUMN origin TEXT");
  // A row no process of ours ever ran (no model answered, nothing spent, nobody started it) is a terminal's, followed by the mirror.
  db.exec("UPDATE sessions SET origin = 'terminal' WHERE model IS NULL AND cost_usd = 0 AND agent IS NULL AND parent_id IS NULL AND kind != 'main'");
}
// Whether reports an agent receives from those under it go on up to its own parent; it decides, per agent.
if (!(db.query("PRAGMA table_info(agents)").all() as { name: string }[]).some((c) => c.name === "bubble")) db.exec("ALTER TABLE agents ADD COLUMN bubble INTEGER NOT NULL DEFAULT 1");
// Routines: a schedule next to the event, an agent next to the action, a check in code before any model runs.
const automationColumns = (db.query("PRAGMA table_info(automations)").all() as { name: string }[]).map((c) => c.name);
if (!automationColumns.includes("schedule")) db.exec("ALTER TABLE automations ADD COLUMN schedule TEXT NOT NULL DEFAULT ''");
if (!automationColumns.includes("agent")) db.exec("ALTER TABLE automations ADD COLUMN agent TEXT NOT NULL DEFAULT ''");
if (!automationColumns.includes("check_rule")) db.exec("ALTER TABLE automations ADD COLUMN check_rule TEXT NOT NULL DEFAULT ''");
if (!automationColumns.includes("owner")) db.exec("ALTER TABLE automations ADD COLUMN owner TEXT NOT NULL DEFAULT 'user'");
if (!automationColumns.includes("last_fire")) db.exec("ALTER TABLE automations ADD COLUMN last_fire TEXT NOT NULL DEFAULT ''");

/** Where a watcher left off. */
export const cursors = {
  get(source: string): string | undefined {
    return (db.query("SELECT value FROM cursors WHERE source = ?").get(source) as { value: string } | undefined)?.value;
  },
  set(source: string, value: string) {
    db.prepare("INSERT OR REPLACE INTO cursors (source, value, updated_at) VALUES (?, ?, ?)").run(source, value, Date.now());
  },
};

export function now() {
  return Date.now();
}

export const kv = {
  get(key: string): string | undefined {
    return (db.query("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  },
  set(key: string, value: string) {
    db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)").run(key, value);
  },
  del(key: string) {
    db.prepare("DELETE FROM kv WHERE key = ?").run(key);
  },
};
