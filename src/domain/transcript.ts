import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * A session's conversation, read from the transcript Claude Code keeps on disk — the same
 * file `claude --resume` reads. The event bus only holds what happened since the daemon
 * started, so this is where a client gets the history of a thread.
 */

// Where Claude Code keeps transcripts; overridable so the tests do not write into the real one.
const projectsDir = process.env.PAI_CLAUDE_PROJECTS ?? join(homedir(), ".claude", "projects");

export interface TranscriptTool {
  readonly name: string;
  readonly input?: string;
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
  message?: { role?: string; content?: string | Block[] };
}

export async function transcript(sessionId: string, cwd?: string, limit = 200): Promise<TranscriptMessage[]> {
  const path = transcriptPath(sessionId, cwd);
  if (!path) return [];
  const lines = (await Bun.file(path).text()).split("\n");
  const messages: TranscriptMessage[] = [];

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
    const message = toMessage(entry);
    if (message) messages.push(message);
  }
  return messages.slice(-limit);
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
    else if (block.type === "tool_use" && block.name) tools.push({ name: block.name, input: summarize(block.input) });
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
