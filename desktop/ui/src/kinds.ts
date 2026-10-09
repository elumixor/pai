import { EVENT_ICONS, ROW_TINTS, type RowTint } from "../../../src/protocol/rich.ts";
import { icon, type IconName } from "./icons.ts";

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
