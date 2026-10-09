import { EVENT_ICONS, ROW_TINTS, type RowTint } from "../../../src/protocol/rich.ts";
import { icon, type IconName } from "./icons.ts";
import type { Agent } from "./types.ts";

/**
 * The icons rows are drawn with. Which symbol a kind gets is decided once, in the protocol
 * (`rich.ts`), as SF Symbol names; here each symbol has the line icon the web draws for it,
 * so this client and Paigram agree on what a delegation or a routine looks like.
 */
const SYMBOLS: Readonly<Record<string, IconName>> = {
  "person.crop.circle.badge.plus": "userPlus",
  "arrow.triangle.branch": "branch",
  "arrow.turn.down.right": "delegate",
  "arrow.turn.up.left": "reply",
  bolt: "zap",
  "clock.arrow.circlepath": "clock",
  envelope: "mail",
  "bubble.left": "message",
  calendar: "calendar",
  "questionmark.bubble": "help",
  "questionmark.circle": "help",
  "hand.raised": "hand",
  "checkmark.bubble": "check",
  paperplane: "send",
  bell: "bell",
  "exclamationmark.triangle": "alert",
  "stop.circle": "stop",
  archivebox: "archive",
  person: "user",
  gearshape: "gear",
};

/** The icon for a row kind or an event name; a lightning bolt for anything the protocol has no symbol for. */
export const kindIcon = (kind: string, size = 11) => icon(SYMBOLS[EVENT_ICONS[kind] ?? ""] ?? "zap", size);

export const kindTint = (kind: string): RowTint => ROW_TINTS[kind] ?? "plain";

/**
 * An agent's icon: the orchestrator has pai's mark, a known area has its own glyph, anything
 * else gets one picked from a small set by its slug, so the same agent keeps the same icon.
 * (An `icon` the agent chooses for itself at creation is the better source once the server has it.)
 */
const AREA_ICONS: readonly [RegExp, IconName][] = [
  [/hiring|recruit|screen/, "users"],
  [/job|career|search/, "globe"],
  [/mail|inbox/, "mail"],
  [/dev|build|code|release/, "code"],
  [/voice|draft|write/, "message"],
  [/balance|calendar|plan/, "calendar"],
  [/linkedin|outreach/, "send"],
  [/research|read/, "book"],
  [/money|finance|invoice|atma/, "folder"],
];
const POOL: readonly IconName[] = ["zap", "brain", "globe", "folder", "key", "list", "clock", "inbox", "branch"];
export function agentIcon(agent: Pick<Agent, "slug" | "name" | "kind">, size = 14) {
  const key = `${agent.slug} ${agent.name}`.toLowerCase();
  const area = AREA_ICONS.find(([re]) => re.test(key))?.[1];
  if (area) return icon(area, size);
  let hash = 0;
  for (const c of agent.slug) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return icon(POOL[hash % POOL.length]!, size);
}
