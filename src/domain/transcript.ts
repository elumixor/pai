import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { config } from "../core/config.ts";

/**
 * A session's conversation, read from the transcript Claude Code keeps on disk — the same
 * file `claude --resume` reads. The event bus only holds what happened since the daemon
 * started, so this is where a client gets the history of a thread.
 */

// Where Claude Code keeps transcripts; overridable so the tests do not write into the real one.
const projectsDir = process.env.PAI_CLAUDE_PROJECTS ?? join(homedir(), ".claude", "projects");

export interface TranscriptTool {
  readonly id?: string;
  readonly name: string;
  readonly input?: string;
  /** The first lines of what the tool returned, as the terminal shows them under the call. */
  readonly result?: string;
}

export interface TranscriptMessage {
  readonly role: "user" | "assistant";
  readonly ts: string;
  readonly text: string;
  readonly thinking?: string;
  readonly tools?: readonly TranscriptTool[];
  /** Injected context rather than something the user typed (task results, tool output, hooks). */
  readonly meta?: boolean;
}

/** Claude Code names a project directory after its cwd, with the separators flattened. */
const slug = (cwd: string) => cwd.replace(/[/.]/g, "-");

/**
 * The transcript directories for a project: the one named after this machine's path, and the
 * ones another machine wrote for the same project under its own `devRoot` (they arrive over
 * sync as `-Users-x-dev-thing` next to this box's `-home-pai-dev-thing`). Same directory
 * name under devRoot, so the same project.
 */
export function transcriptDirs(cwd: string): string[] {
  if (!existsSync(projectsDir)) return [];
  const own = slug(cwd);
  const root = config.devRoot.replace(/\/$/, "");
  const inside = cwd === root || cwd.startsWith(`${root}/`) ? cwd.slice(root.length) : undefined;
  const suffix = inside ? `-${basename(root)}${slug(inside)}` : undefined;
  return readdirSync(projectsDir)
    .filter((name) => name === own || (suffix !== undefined && name !== own && name.endsWith(suffix)))
    .map((name) => join(projectsDir, name))
    .filter((dir) => statSync(dir).isDirectory());
}

export function transcriptPath(sessionId: string, cwd?: string) {
  const fromCwd = cwd ? join(projectsDir, slug(cwd), `${sessionId}.jsonl`) : undefined;
  if (fromCwd && existsSync(fromCwd)) return fromCwd;
  // A session may have been resumed from another directory, so the whole tree is the fallback.
  if (!existsSync(projectsDir)) return undefined;
  for (const project of readdirSync(projectsDir).reverse()) {
    const candidate = join(projectsDir, project, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

interface Block {
  type: string;
  id?: string;
  tool_use_id?: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
}

interface Entry {
  type?: string;
  timestamp?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  cwd?: string;
  sessionId?: string;
  message?: { role?: string; content?: string | Block[] };
}

const RESULT_LINES = 4;
const RESULT_CHARS = 400;

/** What a tool returned, cut to what fits under the call. */
export function resultPreview(content: unknown): string {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((block: Block) => (block.type === "text" ? (block.text ?? "") : `[${block.type}]`)).join("\n")
        : JSON.stringify(content ?? "");
  const lines = text.split("\n").filter((line) => line.trim());
  const cut = lines.slice(0, RESULT_LINES).join("\n").slice(0, RESULT_CHARS);
  const more = lines.length - RESULT_LINES;
  return more > 0 ? `${cut}\n… +${more} lines` : cut;
}

export async function transcript(sessionId: string, cwd?: string, limit = 200): Promise<TranscriptMessage[]> {
  const path = transcriptPath(sessionId, cwd);
  if (!path) return [];
  const lines = (await Bun.file(path).text()).split("\n");
  const messages: TranscriptMessage[] = [];
  // Tool results arrive as user entries; they belong under the call they answer.
  const tools = new Map<string, { name: string; input?: string; result?: string }>();

  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: Entry;
    try {
      entry = JSON.parse(line) as Entry;
    } catch {
      continue;
    }
    if (entry.isSidechain) continue;
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    const content = entry.message?.content;
    if (Array.isArray(content))
      for (const block of content) {
        if (block.type === "tool_result" && block.tool_use_id) {
          const tool = tools.get(block.tool_use_id);
          if (tool) tool.result = resultPreview(block.content);
        }
      }
    const message = toMessage(entry);
    if (!message) continue;
    for (const tool of message.tools ?? []) if (tool.id) tools.set(tool.id, tool as { name: string; input?: string; result?: string });
    messages.push(message);
  }
  return messages.slice(-limit);
}

export interface DiskSession {
  readonly sessionId: string;
  readonly cwd: string;
  readonly title: string;
  readonly lastActivity: string;
}

/** A first prompt with an image pasted into it is one very long line, so the head grows until a whole prompt fits. */
const HEAD_BYTES = [64 * 1024, 2 * 1024 * 1024, 16 * 1024 * 1024];
const titles = new Map<string, { mtime: number; session: DiskSession }>();

/** The first thing the user typed, which is how the terminal names a conversation. */
async function describe(path: string, sessionId: string, cwd: string): Promise<DiskSession | undefined> {
  const file = Bun.file(path);
  for (const bytes of HEAD_BYTES) {
    const found = await titleIn(await file.slice(0, bytes).text(), sessionId, cwd);
    if (found) return found;
    if (bytes >= file.size) return undefined;
  }
  return undefined;
}

function titleIn(head: string, sessionId: string, cwd: string): DiskSession | undefined {
  const lines = head.split("\n");
  lines.pop(); // the last line is cut off
  for (const line of lines) {
    if (!line.includes('"type":"user"')) continue;
    let entry: Entry;
    try {
      entry = JSON.parse(line) as Entry;
    } catch {
      continue;
    }
    if (entry.type !== "user" || entry.isMeta || entry.isSidechain) continue;
    const content = entry.message?.content;
    const text = typeof content === "string" ? content : (content ?? []).find((block) => block.type === "text")?.text;
    if (!text || isInjected(text)) continue;
    const title = text.replace(/\s+/g, " ").trim().slice(0, 80);
    return { sessionId, cwd: entry.cwd ?? cwd, title, lastActivity: "" };
  }
  return undefined;
}

/**
 * Every Claude Code conversation held in a directory — the ones started from a terminal
 * included — newest first. Read from the transcripts, so nothing has to have gone through
 * the daemon for a thread to be here.
 */
export async function sessionsIn(cwd: string, limit = 30): Promise<DiskSession[]> {
  const files = transcriptDirs(cwd)
    .flatMap((dir) =>
      readdirSync(dir)
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => ({ name, path: join(dir, name), mtime: statSync(join(dir, name)).mtimeMs })),
    )
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);
  const out: DiskSession[] = [];
  for (const file of files) {
    const id = file.name.slice(0, -".jsonl".length);
    const cached = titles.get(file.path);
    let session = cached?.mtime === file.mtime ? cached.session : undefined;
    if (!session) {
      const found = await describe(file.path, id, cwd);
      if (!found) continue;
      session = found;
      titles.set(file.path, { mtime: file.mtime, session });
    }
    out.push({ ...session, lastActivity: new Date(file.mtime).toISOString() });
  }
  return out;
}

function toMessage(entry: Entry): TranscriptMessage | undefined {
  const role = entry.type === "assistant" ? "assistant" : "user";
  const ts = entry.timestamp ?? new Date().toISOString();
  const content = entry.message?.content;
  if (typeof content === "string") return { role, ts, text: content, meta: entry.isMeta || isInjected(content) };

  const text: string[] = [];
  const thinking: string[] = [];
  const tools: TranscriptTool[] = [];
  for (const block of content ?? []) {
    if (block.type === "text" && block.text) text.push(block.text);
    else if (block.type === "thinking" && block.thinking) thinking.push(block.thinking);
    else if (block.type === "tool_use" && block.name) tools.push({ id: block.id, name: block.name, input: summarize(block.input) });
  }
  // A user entry with no text is a tool result: the call it answers is already shown.
  if (!text.length && !tools.length && !thinking.length) return undefined;
  return {
    role,
    ts,
    text: text.join("\n"),
    thinking: thinking.join("\n") || undefined,
    tools: tools.length ? tools : undefined,
    meta: entry.isMeta || isInjected(text.join("\n")),
  };
}

/** System reminders, hook output and task results arrive as user messages but were not typed. */
const isInjected = (text: string) =>
  text.startsWith("<") || text.startsWith("Caveat:") || text.includes("<system-reminder>");

function summarize(input: unknown) {
  if (input === undefined || input === null) return undefined;
  const fields = input as Record<string, unknown>;
  const first = fields.command ?? fields.file_path ?? fields.path ?? fields.pattern ?? fields.prompt ?? fields.text;
  const value = typeof first === "string" ? first : JSON.stringify(input);
  return value.length > 200 ? `${value.slice(0, 200)}…` : value;
}
