import type { ModelMessage } from "ai";
import { db, now } from "./db.ts";

db.exec(`
CREATE TABLE IF NOT EXISTS chat (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  role    TEXT NOT NULL,          -- user | assistant
  content TEXT NOT NULL,
  ts      INTEGER NOT NULL
);
`);

const WINDOW = 40;

export function remember(role: "user" | "assistant", content: string) {
  if (!content.trim()) return;
  db.prepare("INSERT INTO chat (role, content, ts) VALUES (?, ?, ?)").run(role, content, now());
}

/** The recent conversation, oldest first, as model messages. */
export function history(limit = WINDOW): ModelMessage[] {
  const rows = db.query("SELECT role, content FROM chat ORDER BY id DESC LIMIT ?").all(limit) as {
    role: "user" | "assistant";
    content: string;
  }[];
  return rows.reverse().map((r) => ({ role: r.role, content: r.content }));
}

export function clear() {
  db.exec("DELETE FROM chat");
}

export function transcript(limit = WINDOW) {
  return db.query("SELECT role, content, ts FROM chat ORDER BY id DESC LIMIT ?").all(limit) as {
    role: string;
    content: string;
    ts: number;
  }[];
}
