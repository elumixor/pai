import { hasKindIcon, kindIcon } from "../kinds";
import { firstLine } from "../format";
import type { IconName } from "../icons";
import type { LogMessage, Question, TranscriptTool } from "../types";

/** One turn's thinking and tool calls, from the transcript or the stream. */
export interface ToolGroup {
  readonly kind: "tools";
  readonly key: string;
  at: number;
  end: number;
  thinking: string;
  tools: TranscriptTool[];
  live: boolean;
  /** The session whose transcript holds these calls in full. */
  readonly session?: string;
}

/** A question the live session asked (`AskUserQuestion`), with its answers as they come. */
export interface LiveQuestion {
  readonly kind: "question";
  readonly key: string;
  readonly at: number;
  readonly session: string;
  readonly id: string;
  readonly questions: readonly Question[];
  answers: string[];
}

export interface Row {
  readonly kind: "message";
  readonly key: string;
  readonly at: number;
  /** A draft card changes in place, so the row it draws is not frozen. */
  m: LogMessage;
}

export type Item = Row | ToolGroup | LiveQuestion;

/**
 * A reply quotes what it answers inline, in the text itself: there is nowhere else to put it that survives a reload
 * (a plain SDK thread's history is only ever the text it was sent). `at` is the target's `createdAt`.
 */
const REPLY_RE = /^↪ (.+?) @ (\d+): "([^"]*)"\n([\s\S]*)$/;
export interface ReplyQuote {
  readonly from: string;
  readonly at: number;
  readonly excerpt: string;
  /** The quoted row's id in the log, when it is one: what a click scrolls to. */
  readonly messageId?: number;
}

export function parseReply(body: string): (ReplyQuote & { text: string }) | undefined {
  const m = REPLY_RE.exec(body);
  return m ? { from: m[1]!, at: Number(m[2]), excerpt: m[3]!, text: m[4]! } : undefined;
}
export const withReply = (quote: ReplyQuote | undefined, text: string) => (quote ? `↪ ${quote.from} @ ${quote.at}: "${quote.excerpt.replace(/"/g, "'")}"\n${text}` : text);
export const excerptOf = (text: string) =>
  firstLine(parseReply(text)?.text ?? text)
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 140);
export const textOf = (m: LogMessage) => parseReply(m.body)?.text ?? m.body;

/** "Created a file, ran 5 commands" — what a turn's tool calls amount to, by family. */
export function describeTools(tools: readonly TranscriptTool[]) {
  const families: Record<string, [string, string]> = {
    Write: ["created a file", "created %n files"],
    Edit: ["edited a file", "edited %n files"],
    Bash: ["ran a command", "ran %n commands"],
    Read: ["read a file", "read %n files"],
    Grep: ["searched", "searched %n times"],
    Glob: ["searched", "searched %n times"],
    WebSearch: ["searched the web", "searched the web %n times"],
    WebFetch: ["fetched a page", "fetched %n pages"],
    Agent: ["delegated once", "delegated %n times"],
  };
  const counts = new Map<string, number>();
  for (const t of tools) {
    const family = families[t.name] ? t.name : "other";
    counts.set(family, (counts.get(family) ?? 0) + 1);
  }
  const text = [...counts]
    .map(([family, n]) => {
      const [one, many] = families[family] ?? ["used a tool", "%n tool calls"];
      return n === 1 ? one : many.replace("%n", String(n));
    })
    .join(", ");
  return text ? text[0]!.toUpperCase() + text.slice(1) : "";
}

/** Built-in tools as the chat says them: a verb and an icon. */
const TOOL_VERBS: Record<string, [string, IconName]> = {
  Bash: ["Ran", "terminal"],
  Read: ["Read", "file"],
  Edit: ["Edited", "pencil"],
  MultiEdit: ["Edited", "pencil"],
  Write: ["Created", "file"],
  NotebookEdit: ["Edited", "pencil"],
  Grep: ["Searched", "search"],
  Glob: ["Found files", "search"],
  WebSearch: ["Searched the web", "globe"],
  WebFetch: ["Fetched", "globe"],
  Agent: ["Delegated", "bot"],
  Task: ["Delegated", "bot"],
  ToolSearch: ["Loaded tools", "wrench"],
  TodoWrite: ["Updated the plan", "list"],
  Skill: ["Used a skill", "book"],
  AskUserQuestion: ["Asked you", "help"],
};
const SERVER_ICONS: Record<string, IconName> = { gmail: "mail", mail: "mail", calendar: "calendar", balance: "calendar", playwright: "globe", browser: "globe", tg: "message", telegram: "message", linkedin: "users", pai: "zap" };
const sentence = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** `mcp__claude_ai_Gmail__gmail_search` → server "Gmail", action "Search"; a built-in → its verb. */
export function toolLabel(name: string): { server?: string; action: string; icon: IconName } {
  const builtin = TOOL_VERBS[name];
  if (builtin) return { action: builtin[0], icon: builtin[1] };
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (!mcp) return { action: sentence(name.replace(/_/g, " ")), icon: "wrench" };
  const server = mcp[1]!.replace(/^claude_ai_/, "").replace(/^plugin_[^_]+_/, "").replace(/_/g, " ");
  const key = server.toLowerCase();
  const action = mcp[2]!.replace(new RegExp(`^${key.replace(/\W/g, "_")}_`, "i"), "").replace(/[_-]+/g, " ");
  return { server: sentence(server), action: sentence(action), icon: SERVER_ICONS[key] ?? "zap" };
}

/** What the call was about, without the tool's name the summary starts with. */
export function toolArgument(tool: TranscriptTool) {
  const short = tool.name.replace(/^mcp__/, "").replace(/__/g, ":");
  let text = (tool.input ?? "").trim();
  for (const prefix of [short, tool.name]) if (text.startsWith(prefix)) text = text.slice(prefix.length).trim();
  if (tool.name === "ToolSearch") text = text.replace(/^select:/, "").replace(/mcp__[^_]+(?:_[^_]+)*?__/g, "").replace(/,/g, ", ");
  return text.replace(/^(\$|search|fetch|agent:)\s+/, "").replace(/^"(.*)"$/, "$1");
}

/** A preview the daemon cut ends in "… +N lines". */
export const CUT = /\n… \+(\d+) lines$/;

/** "12 lines", "no output" — how much came back, for the end of the row. */
export function resultSize(result: string) {
  const text = result.trim();
  if (!text || text === "[]" || text === "{}") return "no output";
  const hidden = Number(CUT.exec(text)?.[1] ?? 0);
  const lines = text.replace(CUT, "").split("\n").length + hidden;
  return lines > 1 ? `${lines} lines` : "";
}

/** A call's input as a person reads it: the command, the path, else the fields. */
export function inputText(name: string, input: unknown) {
  if (!input || typeof input !== "object") return String(input ?? "");
  const fields = input as Record<string, unknown>;
  if (name === "Bash" && typeof fields.command === "string") return fields.command;
  const values = Object.values(fields);
  if (values.length === 1 && typeof values[0] === "string") return values[0];
  return JSON.stringify(fields, null, 2);
}

/** What an event is of: its source when it has one (telegram, gmail), else its event name. */
export const eventType = (m: LogMessage) => (m.meta.source ?? m.meta.event ?? "event").toLowerCase();
const TYPE_LABEL: Record<string, string> = {
  telegram: "Telegram",
  gmail: "Email",
  mail: "Email",
  linkedin: "LinkedIn",
  "routine.fired": "routines",
  "calendar.upcoming": "calendar events",
  "item.arrived": "items",
  rate_limited: "paused on the account's limit",
};
export const typeLabel = (type: string) => TYPE_LABEL[type] ?? type.replace(/^item\./, "");
/** The icon by where it came from when the source has one (Telegram, LinkedIn), else by the event. */
export const eventIcon = (m: LogMessage) => kindIcon(hasKindIcon(`item.${eventType(m)}`) ? `item.${eventType(m)}` : (m.meta.event ?? "event"));

/** How big a file is, as a row says it. */
export const fileSize = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** A kept attachment is a name on the row (`a1b2….jpg`); a local preview is already a data url. */
export const KEPT = /^[0-9a-f]{16}\.\w+$/;

/** A row's first line, for its pill: the headline when the daemon wrote one. */
export const lineOf = (m: LogMessage, fallback = firstLine(m.body)) => m.meta.headline ?? fallback;
