import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { config } from "../core/config.ts";
import { IMAGE_REF, keep } from "./attachments.ts";

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
  /** Pictures in the message, as names `GET /attachments/<name>` serves. */
  readonly images?: readonly string[];
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
  source?: { type?: string; media_type?: string; data?: string };
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

/** What a tool returned, as text. */
function resultText(content: unknown): string {
  return typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((block: Block) => (block.type === "text" ? (block.text ?? "") : `[${block.type}]`)).join("\n")
      : JSON.stringify(content ?? "");
}

/** What a tool returned, cut to what fits under the call. */
export function resultPreview(content: unknown): string {
  const text = resultText(content);
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

const FULL_CHARS = 200_000;

/** One call in full, as the transcript holds it: its input and everything it returned (capped at 200k characters). */
export async function toolCall(sessionId: string, toolId: string, cwd?: string): Promise<{ name: string; input: unknown; result?: string } | undefined> {
  const path = transcriptPath(sessionId, cwd);
  if (!path) return undefined;
  let call: { name: string; input: unknown; result?: string } | undefined;
  for (const line of (await Bun.file(path).text()).split("\n")) {
    if (!line.includes(toolId)) continue;
    let entry: Entry;
    try {
      entry = JSON.parse(line) as Entry;
    } catch {
      continue;
    }
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === "tool_use" && block.id === toolId) call = { name: block.name ?? "tool", input: block.input };
      else if (block.type === "tool_result" && block.tool_use_id === toolId && call) {
        const text = resultText(block.content);
        call.result = text.length > FULL_CHARS ? `${text.slice(0, FULL_CHARS)}\n… cut at ${FULL_CHARS.toLocaleString("en")} characters` : text;
        return call;
      }
    }
  }
  return call;
}

export interface DiskSession {
  readonly sessionId: string;
  readonly cwd: string;
  readonly title: string;
  readonly lastActivity: string;
}

export interface Thread extends DiskSession {
  readonly project: string | null;
  readonly shortId: string;
}

/**
 * Every conversation held in any project — the box's own and the ones synced from another
 * machine — newest first, `perProject` from each. This is what a person chooses from.
 */
export async function allThreads(perProject = 15): Promise<Thread[]> {
  const { all } = await import("./catalog.ts");
  const out: Thread[] = [];
  for (const project of all()) {
    const found = await sessionsIn(project.path, perProject).catch(() => []);
    for (const s of found) out.push({ ...s, project: project.slug, shortId: s.sessionId.slice(0, 6) });
  }
  return out.sort((a, b) => Date.parse(b.lastActivity) - Date.parse(a.lastActivity));
}

/**
 * `claude --resume` looks only under the directory named after its cwd; a transcript that
 * another machine wrote for the same project sits under that machine's name. The newest of
 * the copies is put there, so the terminal finds it and continues from what was said last,
 * wherever that was.
 */
export function ensureTranscriptAt(sessionId: string, cwd: string) {
  const wanted = join(projectsDir, slug(cwd), `${sessionId}.jsonl`);
  if (!existsSync(projectsDir)) return existsSync(wanted) ? wanted : undefined;
  const newest = readdirSync(projectsDir)
    .map((dir) => join(projectsDir, dir, `${sessionId}.jsonl`))
    .filter((path) => existsSync(path))
    .map((path) => ({ path, mtime: statSync(path).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0];
  if (!newest) return undefined;
  if (newest.path === wanted) return wanted;
  mkdirSync(join(projectsDir, slug(cwd)), { recursive: true });
  copyFileSync(newest.path, wanted);
  return wanted;
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
    // The directory asked for, not the one in the entry: a transcript synced from another machine names that machine's path.
    return { sessionId, cwd, title, lastActivity: "" };
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
  if (typeof content === "string") {
    const { text, images } = imageRefs(content);
    return { role, ts, text, images, meta: entry.isMeta || isInjected(content) };
  }

  const text: string[] = [];
  const images: string[] = [];
  const thinking: string[] = [];
  const tools: TranscriptTool[] = [];
  for (const block of content ?? []) {
    if (block.type === "text" && block.text) text.push(block.text);
    else if (block.type === "thinking" && block.thinking) thinking.push(block.thinking);
    else if (block.type === "tool_use" && block.name) tools.push({ id: block.id, name: block.name, input: summarize(block.input) });
    else if (block.type === "image" && block.source?.type === "base64" && block.source.data) images.push(keep({ media_type: block.source.media_type ?? "image/png", data: block.source.data }));
  }
  // A user entry with no text is a tool result: the call it answers is already shown.
  if (!text.length && !tools.length && !thinking.length && !images.length) return undefined;
  const typed = imageRefs(text.join("\n"));
  images.push(...(typed.images ?? []));
  return {
    role,
    ts,
    text: typed.text,
    images: images.length ? images : undefined,
    thinking: thinking.join("\n") || undefined,
    tools: tools.length ? tools : undefined,
    meta: entry.isMeta || isInjected(text.join("\n")),
  };
}

/** A message that reached a terminal as text names its pictures in `[image: …]` lines: those become images. */
function imageRefs(raw: string): { text: string; images?: string[] } {
  const images = [...raw.matchAll(IMAGE_REF)].map((m) => m[1]!);
  return images.length ? { text: raw.replace(IMAGE_REF, "").trim(), images } : { text: raw };
}

/** System reminders, hook output and task results arrive as user messages but were not typed. */
export const isInjected = (text: string) =>
  text.startsWith("<") || text.startsWith("Caveat:") || text.includes("<system-reminder>");

function summarize(input: unknown) {
  if (input === undefined || input === null) return undefined;
  const fields = input as Record<string, unknown>;
  const first = fields.command ?? fields.file_path ?? fields.path ?? fields.pattern ?? fields.prompt ?? fields.text;
  const value = typeof first === "string" ? first : JSON.stringify(input);
  return value.length > 200 ? `${value.slice(0, 200)}…` : value;
}

export interface Conversation {
  readonly id: string;
  /** The project as the user knows it: the directory name under ~/dev, or the path for anything else. */
  readonly project: string;
  readonly title: string;
  readonly lastActivity: string;
  readonly kb: number;
  /** A coding thread pai started for the user, rather than a conversation the user opened. */
  readonly byPai?: boolean;
}

/** pai's own sessions and throwaway scratch directories are not the user's conversations. */
const ownOrScratch = (dir: string) => dir.includes("-pai-workspace") || /^-(private-)?tmp-/.test(dir) || dir.startsWith("-var-");

/** `-Users-x-dev-balance-app` → `balance-app`, `-home-pai-dev-pai` → `pai`, `-Users-x` → `~`. */
function projectLabel(dir: string) {
  const dev = dir.lastIndexOf("-dev-");
  if (dev >= 0) return dir.slice(dev + "-dev-".length);
  return /^-(Users|home)-[^-]+$/.test(dir) ? "~" : dir.replace(/^-/, "/").replaceAll("-", "/");
}

/**
 * The user's Claude Code conversations from the last `days` days, every project and both machines
 * (the Mac's arrive over sync), newest first — what someone reviewing how the user works reads first.
 */
export async function conversations(days = 60, limit = 300): Promise<Conversation[]> {
  if (!existsSync(projectsDir)) return [];
  const since = Date.now() - days * 86_400_000;
  const files = readdirSync(projectsDir)
    .filter((dir) => !ownOrScratch(dir) && statSync(join(projectsDir, dir)).isDirectory())
    .flatMap((dir) =>
      readdirSync(join(projectsDir, dir))
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => {
          const path = join(projectsDir, dir, name);
          const stat = statSync(path);
          return { dir, path, id: name.slice(0, -".jsonl".length), mtime: stat.mtimeMs, size: stat.size };
        }),
    )
    .filter((f) => f.mtime >= since)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);
  const out: Conversation[] = [];
  for (const f of files) {
    const cached = titles.get(f.path);
    const session = cached?.mtime === f.mtime ? cached.session : await describe(f.path, f.id, "");
    if (!session) continue;
    titles.set(f.path, { mtime: f.mtime, session });
    out.push({ id: f.id, project: projectLabel(f.dir), title: session.title, lastActivity: new Date(f.mtime).toISOString(), kb: Math.round(f.size / 1024), ...(session.title.startsWith("You are session") ? { byPai: true } : {}) });
  }
  return out;
}

const DIGEST_MESSAGE_CHARS = 1500;

/** A conversation's full id from its first characters, the way lists and people quote it. */
function resolveId(id: string): string | undefined {
  if (id.length >= 36 || !existsSync(projectsDir)) return id;
  for (const dir of readdirSync(projectsDir)) {
    const path = join(projectsDir, dir);
    if (!statSync(path).isDirectory()) continue;
    const found = readdirSync(path).find((name) => name.startsWith(id) && name.endsWith(".jsonl"));
    if (found) return found.slice(0, -".jsonl".length);
  }
  return undefined;
}

/**
 * One conversation as what was said: the user's prompts and the assistant's answers, without tool
 * output or injected context, each message cut short. Past `maxChars` the middle goes: how a
 * conversation starts and how it ends say the most.
 */
export async function conversationDigest(id: string, maxChars = 30_000): Promise<string> {
  const full = resolveId(id);
  if (!full) throw new Error(`no conversation ${id}`);
  const messages = (await transcript(full, undefined, 100_000)).filter((m) => !m.meta && m.text.trim());
  const lines = messages.map((m) => {
    const text = m.text.replace(/\n{3,}/g, "\n\n").trim();
    const cut = text.length > DIGEST_MESSAGE_CHARS ? `${text.slice(0, DIGEST_MESSAGE_CHARS)}…` : text;
    return `${m.role === "user" ? "USER" : "CLAUDE"} (${m.ts.slice(0, 16)}): ${cut}`;
  });
  const all = lines.join("\n\n");
  if (all.length <= maxChars) return all || "(empty conversation)";
  const head = all.slice(0, Math.floor(maxChars * 0.4));
  const tail = all.slice(-Math.floor(maxChars * 0.6));
  return `${head}\n\n[… ${all.length - head.length - tail.length} characters left out …]\n\n${tail}`;
}
