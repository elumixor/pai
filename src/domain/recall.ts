import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { cursors, db } from "../core/db.ts";
import { logger } from "../core/log.ts";

const log = logger("recall");

/**
 * The archive: transcripts, the message log, and copies of the mail and chats the watchers saw,
 * in one SQLite full-text table, searched with the recall tool. At personal scale the model
 * searching with good keywords (names, dates, subjects) beats similarity search; nothing here
 * is deleted, it is only demoted from a loaded layer to a searched one.
 */

const projectsDir = process.env.PAI_CLAUDE_PROJECTS ?? join(homedir(), ".claude", "projects");
/** Per pass: a first index of a large history spreads over several minutes instead of blocking the daemon. */
const BYTES_PER_PASS = 8 * 1024 * 1024;
const MAX_ENTRY = 4000;

export interface Hit {
  readonly source: string;
  readonly ref: string;
  readonly title: string;
  readonly snippet: string;
  readonly at: string;
}

/** Into the archive. `ref` says where it came from (a session id, a message id, a mail id). */
export function put(source: string, ref: string, title: string, body: string, at = Date.now()) {
  if (!body.trim()) return;
  db.prepare("INSERT INTO archive (source, ref, title, body, ts) VALUES (?, ?, ?, ?, ?)").run(source, ref, title, body.slice(0, MAX_ENTRY), at);
}

/** Words as FTS5 terms: quoted, so punctuation in a name is not syntax; a phrase in quotes stays a phrase. */
export function ftsQuery(text: string) {
  const parts = text.match(/"[^"]+"|\S+/g) ?? [];
  const terms = parts
    .map((p) => p.replace(/^"|"$/g, "").replace(/"/g, ""))
    .filter((p) => p.length > 0 && !/^(and|or|not)$/i.test(p))
    .map((p) => `"${p}"`);
  return terms.join(" ");
}

export function search(text: string, opts: { sources?: string[]; limit?: number } = {}): Hit[] {
  const q = ftsQuery(text);
  if (!q) return [];
  const limit = Math.min(opts.limit ?? 15, 50);
  const where = opts.sources?.length ? `AND source IN (${opts.sources.map(() => "?").join(", ")})` : "";
  const rows = db
    .query(`SELECT source, ref, title, snippet(archive, 3, '[', ']', '…', 24) AS snippet, ts FROM archive WHERE archive MATCH ? ${where} ORDER BY bm25(archive) LIMIT ?`)
    .all(q, ...(opts.sources ?? []), limit) as { source: string; ref: string; title: string; snippet: string; ts: number }[];
  return rows.map((r) => ({ source: r.source, ref: r.ref, title: r.title, snippet: r.snippet, at: new Date(Number(r.ts)).toISOString().slice(0, 16) }));
}

export function stats() {
  return db.query("SELECT source, COUNT(*) AS entries FROM archive GROUP BY source").all() as { source: string; entries: number }[];
}

// ---- transcripts -------------------------------------------------------------

interface Line {
  type?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  message?: { role?: string; content?: unknown };
}

/** The text a person or the assistant said in one transcript line; tool calls and results are left out. */
export function said(line: Line): string {
  if (line.isMeta || line.isSidechain || (line.type !== "user" && line.type !== "assistant")) return "";
  const content = line.message?.content;
  if (typeof content === "string") return content.startsWith("<") ? "" : content;
  if (!Array.isArray(content)) return "";
  return (content as { type: string; text?: string }[])
    .filter((b) => b.type === "text" && b.text && !b.text.startsWith("<"))
    .map((b) => b.text!)
    .join("\n");
}

/** Reads what each transcript gained since the last pass. Returns how many entries went in. */
export async function indexTranscripts(budget = BYTES_PER_PASS): Promise<number> {
  if (!existsSync(projectsDir)) return 0;
  let added = 0;
  let spent = 0;
  for (const project of readdirSync(projectsDir)) {
    const dir = join(projectsDir, project);
    if (project.startsWith(".") || !statSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(dir, name);
      const size = statSync(path).size;
      const key = `transcript:${path}`;
      const offset = Number(cursors.get(key) ?? 0);
      if (size <= offset) continue;
      const take = Math.min(size - offset, Math.max(budget - spent, 0));
      if (take <= 0) return added;
      const chunk = await Bun.file(path).slice(offset, offset + take).text();
      // Only whole lines: the rest is read next time.
      const end = chunk.lastIndexOf("\n");
      if (end < 0) {
        if (take === size - offset) cursors.set(key, String(size));
        continue;
      }
      const session = basename(name, ".jsonl");
      const insert = db.transaction((lines: string[]) => {
        for (const raw of lines) {
          if (!raw.trim()) continue;
          let line: Line;
          try {
            line = JSON.parse(raw) as Line;
          } catch {
            continue;
          }
          const text = said(line);
          if (!text.trim()) continue;
          put("transcript", session, `${line.type === "user" ? "user" : "assistant"} · ${line.cwd ? basename(line.cwd) : project}`, text, line.timestamp ? Date.parse(line.timestamp) : Date.now());
          added += 1;
        }
      });
      insert(chunk.slice(0, end).split("\n"));
      cursors.set(key, String(offset + Buffer.byteLength(chunk.slice(0, end + 1))));
      spent += take;
    }
  }
  return added;
}

/** Keeps the archive up with the transcripts, a slice at a time. */
export function start() {
  let running = false;
  const pass = async () => {
    if (running) return;
    running = true;
    try {
      const added = await indexTranscripts();
      if (added) log.info(`archived ${added} transcript entries`);
    } catch (err) {
      log.warn(`transcripts: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(pass, 30_000);
  const timer = setInterval(pass, 2 * 60_000);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
