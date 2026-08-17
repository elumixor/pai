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
  session_id   TEXT PRIMARY KEY,
  short_id     TEXT NOT NULL,
  project      TEXT NOT NULL,
  cwd          TEXT NOT NULL,
  title        TEXT NOT NULL DEFAULT '',
  state        TEXT NOT NULL,            -- starting | idle | busy | dead
  pid          INTEGER,
  started_at   INTEGER NOT NULL,
  last_activity INTEGER NOT NULL,
  last_result  TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT,
  project     TEXT,
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
`);

export function now() {
  return Date.now();
}
