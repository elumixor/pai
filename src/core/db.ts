import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.ts";

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath, { create: true });
db.exec("PRAGMA journal_mode = WAL;");

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

CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

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
