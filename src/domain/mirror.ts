import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { bus } from "../core/bus.ts";
import { config } from "../core/config.ts";
import { db, now } from "../core/db.ts";
import { logger } from "../core/log.ts";
import { all as allProjects } from "./catalog.ts";
import * as channels from "./channels.ts";
import { summarizeTool, type SessionKind } from "./session.ts";
import * as sessions from "./sessions.ts";
import { isInjected, transcript, transcriptDirs } from "./transcript.ts";

/**
 * Conversations a terminal holds — `claude` on the Mac (its transcripts arrive over sync) or
 * on this box — followed through their transcripts as they grow and told to the bus as the
 * events a daemon session emits, so every client shows them like any other thread. A message
 * for one goes into the terminal through its channel (`pai channel`) while it is connected;
 * otherwise the daemon resumes the conversation here and answers it itself.
 */

const log = logger("mirror");
const projectsDir = process.env.PAI_CLAUDE_PROJECTS ?? join(homedir(), ".claude", "projects");
const POLL_MS = 1500;
/** A conversation that went quiet this long ago is not announced when the daemon finds it on start. */
const RECENT_MS = 24 * 60 * 60 * 1000;
const RECENT_TOOLS = 5;

interface Place {
  readonly cwd: string;
  readonly project?: string;
  readonly kind: SessionKind;
}

interface Entry {
  type?: string;
  subtype?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  entrypoint?: string;
  aiTitle?: string;
  durationMs?: number;
  toolUseResult?: unknown;
  origin?: { kind?: string };
  message?: { content?: string | { type: string; text?: string; name?: string; input?: Record<string, unknown> }[] };
}

/** A conversation one of the terminals holds, with what the frontends need to show it as a thread. */
export class TerminalThread {
  readonly id: string;
  readonly shortId: string;
  readonly kind: SessionKind;
  readonly cwd: string;
  readonly project?: string;
  readonly parent = null;
  readonly pending = undefined;
  title: string;
  threadId: number | null;
  cardId: number | null;
  turns: number;
  readonly costUsd = 0;
  recentTools: string[] = [];
  private busy = false;
  private turnStarted = 0;
  /** The last text block of the turn, held back until a tool call or the turn's end says whether it was the answer. */
  private text = "";

  constructor(id: string, place: Place, title: string) {
    const row = db.query("SELECT kind, cwd, project, title, thread_id, card_id, turns FROM sessions WHERE session_id = ?").get(id) as
      | { kind: SessionKind; cwd: string; project: string | null; title: string; thread_id: number | null; card_id: number | null; turns: number }
      | undefined;
    this.id = id;
    this.shortId = id.slice(0, 6);
    this.kind = row?.kind ?? place.kind;
    this.cwd = row?.cwd ?? place.cwd;
    this.project = row?.project ?? place.project;
    this.title = row?.title || title || this.shortId;
    this.threadId = row?.thread_id ?? null;
    this.cardId = row?.card_id ?? null;
    this.turns = row?.turns ?? 0;
  }

  get state(): "busy" | "idle" {
    return this.busy ? "busy" : "idle";
  }

  persist() {
    db.prepare(
      `INSERT INTO sessions (session_id, short_id, kind, title, cwd, project, thread_id, card_id, state, started_at, last_activity, turns, origin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'terminal')
       ON CONFLICT(session_id) DO UPDATE SET title=excluded.title, thread_id=excluded.thread_id, card_id=excluded.card_id,
         state=excluded.state, last_activity=excluded.last_activity, turns=excluded.turns, origin=COALESCE(sessions.origin, excluded.origin)`,
    ).run(this.id, this.shortId, this.kind, this.title, this.cwd, this.project ?? null, this.threadId, this.cardId, this.state, now(), now(), this.turns);
    sessions.terminalStates.set(this.id, this.state);
  }

  summary() {
    return { sessionId: this.id, shortId: this.shortId, kind: this.kind, title: this.title, project: this.project, cwd: this.cwd, threadId: this.threadId, state: this.state, turns: this.turns, terminal: true };
  }

  /**
   * Into the terminal while its channel is connected. A turn running in a terminal pai cannot
   * reach (started without the channel) is left alone; otherwise the conversation is resumed
   * here and answers itself.
   */
  send(text: string, opts: { images?: { media_type: string; data: string }[] } = {}) {
    if (channels.deliver(this.id, text)) return;
    if (this.busy) {
      bus.emitEvent("session.progress", { text: "Not sent: this conversation is mid-turn in a terminal started without the pai channel. Try again once it is done, and I will continue it here.", terminal: true }, this.id);
      return;
    }
    log.info(`${this.shortId}: no terminal connected, resuming it here`);
    sessions.adopt(this.id, this.cwd, this.title).send(text, opts);
  }

  async interrupt() {
    return false;
  }

  replay(entries: Entry[]) {
    this.turns = 0;
    for (const e of entries) this.take(e, true);
  }

  /** One transcript entry, told to the bus; `quiet` only follows along (what history already showed). */
  take(e: Entry, quiet: boolean) {
    const emit = (kind: string, payload: Record<string, unknown>) => !quiet && bus.emitEvent(kind, { ...payload, terminal: true }, this.id);
    if (e.type === "ai-title" && e.aiTitle && e.aiTitle !== this.title) {
      this.title = e.aiTitle.slice(0, 80);
      this.persist();
      return;
    }
    if (e.type === "system" && e.subtype === "turn_duration") return this.endTurn(emit, e.durationMs);
    const content = e.message?.content;
    if (e.type === "user" && !e.isMeta && !e.toolUseResult) {
      const typed = typeof content === "string" ? content : (content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
      if (!typed.trim() || isInterruption(typed) || (Array.isArray(content) && content.some((b) => b.type === "tool_result"))) return;
      // A prompt arriving mid-turn means the last one was cut off (Esc) without a turn_duration.
      if (this.busy) this.endTurn(emit);
      const human = e.origin ? e.origin.kind === "human" : !isInjected(typed);
      this.busy = true;
      this.turnStarted = now();
      this.recentTools = [];
      this.persist();
      // What came in through the channel is already in the chat it was typed in; only the turn starts.
      emit("session.input", human ? { text: typed, echo: true } : { text: "" });
      return;
    }
    if (e.type !== "assistant" || !Array.isArray(content)) return;
    for (const block of content) {
      if (block.type === "text" && block.text?.trim()) {
        this.flushText(emit);
        this.text = block.text;
      } else if (block.type === "tool_use" && block.name) {
        this.flushText(emit);
        const summary = summarizeTool(block.name, block.input);
        this.recentTools = [...this.recentTools.slice(-(RECENT_TOOLS - 1)), summary];
        emit("session.tool", { name: block.name, summary });
      }
    }
  }

  private flushText(emit: (kind: string, payload: Record<string, unknown>) => unknown) {
    if (!this.text) return;
    emit("session.text", { text: this.text, flush: true });
    this.text = "";
  }

  private endTurn(emit: (kind: string, payload: Record<string, unknown>) => unknown, durationMs?: number) {
    if (!this.busy) return;
    this.busy = false;
    this.turns += 1;
    this.persist();
    emit("session.turn_end", { text: this.text, durationMs: durationMs ?? now() - this.turnStarted });
    this.text = "";
    this.recentTools = [];
  }
}

const threads = new Map<string, TerminalThread>();
const offsets = new Map<string, number>();

export function find(idOrShort: string): TerminalThread | undefined {
  return threads.get(idOrShort) ?? [...threads.values()].find((t) => t.shortId === idOrShort);
}

/** The terminal thread a topic belongs to, unless the daemon is running that conversation itself right now. */
export function byThread(threadId: number): TerminalThread | undefined {
  const t = [...threads.values()].find((x) => x.threadId === threadId);
  if (!t) return undefined;
  const own = sessions.find(t.id);
  return own && own.state !== "dead" ? undefined : t;
}

/** Transcript directories of the places a conversation can be resumed in here: every project, and the workspace. */
function places(): Map<string, Place> {
  const out = new Map<string, Place>();
  for (const dir of transcriptDirs(config.workspace)) out.set(dir, { cwd: config.workspace, kind: "chat" });
  for (const p of allProjects())
    for (const dir of transcriptDirs(p.path)) out.set(dir, { cwd: p.path, project: p.slug, kind: p.kind === "repo" ? "code" : "chat" });
  return out;
}

function saveOffset(path: string, offset: number) {
  offsets.set(path, offset);
  db.prepare("INSERT OR REPLACE INTO transcript_offsets (path, offset) VALUES (?, ?)").run(path, offset);
}

/** Complete lines appended since `from`, and where reading stopped (a line still being written waits for the next look). */
function readFrom(path: string, from: number, to: number): { lines: string[]; end: number } {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(to - from);
    readSync(fd, buf, 0, buf.length, from);
    const last = buf.lastIndexOf(0x0a);
    if (last < 0) return { lines: [], end: from };
    return { lines: buf.subarray(0, last).toString("utf8").split("\n"), end: from + last + 1 };
  } finally {
    closeSync(fd);
  }
}

function parse(line: string): Entry | undefined {
  try {
    const e = JSON.parse(line) as Entry;
    return e.isSidechain || e.entrypoint?.startsWith("sdk") ? undefined : e;
  } catch {
    return undefined;
  }
}

const isPrompt = (e: Entry) => e.type === "user" && e.origin?.kind === "human";

/** Written by `claude` in a terminal, as opposed to the daemon's own sessions (sdk) or bookkeeping lines. */
const fromTerminal = (e: Entry) => e.entrypoint === "cli";
const isInterruption = (text: string) => text.startsWith("[Request interrupted");

async function follow(path: string, place: Place, size: number, startup: boolean) {
  const id = basename(path, ".jsonl");
  const known = offsets.get(path);
  if (known === size) return;
  if (known !== undefined && size < known) return saveOffset(path, size);
  if (known === undefined) {
    const threaded = Boolean(topicOf(id));
    // On start: what changed while the daemon was down opens with its recent past; the first run ever announces nothing.
    if (startup) return !firstRun && !threaded && Date.now() - statSync(path).mtimeMs < RECENT_MS ? announce(id, place, path, size) : saveOffset(path, size);
    // A copy of a conversation that already has a thread (resumed here from another machine's transcript) starts where it is.
    if (threaded) return saveOffset(path, size);
  }
  const from = known ?? 0;
  const { lines, end } = readFrom(path, from, size);
  if (end === from) return;
  saveOffset(path, end);
  const own = sessions.find(id);
  if (own && own.state !== "dead") return; // the daemon is running it and tells the bus itself
  const entries = lines.map(parse).filter((e): e is Entry => e !== undefined);
  let thread = threads.get(id);
  if (!thread) {
    if (!entries.some(fromTerminal)) return;
    if (!topicOf(id)) {
      // A conversation with a past the chat has not seen opens with it; a new one once something is typed.
      const before = from > 0 ? (await transcript(id, place.cwd, 1000).catch(() => [])).filter((m) => m.role === "user" && !m.meta).length : 0;
      if (before > entries.filter(isPrompt).length) return announce(id, place, path, end);
      if (!entries.some(isPrompt)) return;
    }
    thread = open(id, place, entries);
    // Followed before (the daemon restarted): where the conversation stands — mid-turn, how many turns — comes from what was read then.
    if (from > 0) thread.replay(readFrom(path, 0, from).lines.map(parse).filter((e): e is Entry => e !== undefined));
  }
  for (const e of entries) thread.take(e, false);
}

function topicOf(id: string): number | null {
  return (db.query("SELECT thread_id FROM sessions WHERE session_id = ?").get(id) as { thread_id: number | null } | undefined)?.thread_id ?? null;
}

/** A thread for the conversation; one the chat has never shown asks for a topic (with its past, when `adopted`). */
function open(id: string, place: Place, entries: Entry[], adopted = false) {
  const first = entries.find(isPrompt)?.message?.content;
  const prompt = typeof first === "string" ? first : (first ?? []).find((b) => b.type === "text")?.text ?? "";
  const title = entries.findLast((e) => e.type === "ai-title")?.aiTitle ?? prompt.replace(/\s+/g, " ").trim().slice(0, 80);
  const thread = new TerminalThread(id, place, title);
  const known = thread.threadId !== null;
  threads.set(id, thread);
  thread.persist();
  log.info(`${thread.shortId}: following "${thread.title}" (${thread.project ?? "workspace"})`);
  bus.emitEvent("task.created", { ...thread.summary(), adopted: adopted && !known }, id);
  return thread;
}

/** A conversation with a past the chat has not seen: it opens with its recent exchanges, then follows along. */
async function announce(id: string, place: Place, path: string, size: number) {
  const { lines, end } = readFrom(path, 0, size);
  saveOffset(path, end);
  const entries = lines.map(parse).filter((e): e is Entry => e !== undefined);
  if (!entries.some(isPrompt) || !entries.some(fromTerminal)) return;
  const own = sessions.find(id);
  if (own && own.state !== "dead") return;
  const thread = threads.get(id) ?? open(id, place, entries, true);
  for (const e of entries) thread.take(e, true);
}

let busy = false;
let firstRun = false;

async function scan(startup = false) {
  if (busy) return;
  busy = true;
  try {
    for (const [dir, place] of places()) {
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".jsonl")) continue;
        const path = join(dir, name);
        try {
          await follow(path, place, statSync(path).size, startup);
        } catch (err) {
          log.warn(`${name}: ${(err as Error).message}`);
        }
      }
    }
  } finally {
    busy = false;
  }
}

/** Follows every transcript from here on; the ones touched since the last run are announced. */
export function start() {
  for (const row of db.query("SELECT path, offset FROM transcript_offsets").all() as { path: string; offset: number }[]) offsets.set(row.path, row.offset);
  firstRun = offsets.size === 0;
  if (!existsSync(projectsDir)) log.info(`${projectsDir} does not exist yet`);
  void scan(true).then(() => log.info(`following ${offsets.size} transcripts`));
  const timer = setInterval(() => void scan(), POLL_MS);
  return () => clearInterval(timer);
}
