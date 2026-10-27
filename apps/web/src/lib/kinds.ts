import { EVENT_ICONS, ROW_TINTS, type RowTint } from "$protocol/rich";
import type { IconName } from "./icons";

/**
 * The icons rows are drawn with. Which symbol a kind gets is decided once, in the protocol (`rich.ts`), as SF Symbol
 * names; here each symbol has the line icon the web draws for it, so this client and Paigram agree.
 */
const SYMBOLS: Readonly<Record<string, IconName>> = {
  "person.crop.circle.badge.plus": "userPlus",
  "arrow.triangle.branch": "rocket",
  "arrow.turn.down.right": "delegate",
  "arrow.turn.up.left": "reply",
  bolt: "zap",
  "clock.arrow.circlepath": "hourglass",
  hourglass: "hourglass",
  envelope: "mail",
  "bubble.left": "message",
  calendar: "calendar",
  "questionmark.bubble": "help",
  "questionmark.circle": "help",
  "hand.raised": "hand",
  "checkmark.bubble": "circleCheck",
  paperplane: "send",
  bell: "bell",
  "exclamationmark.triangle": "alert",
  "stop.circle": "stop",
  archivebox: "archive",
  person: "user",
  gearshape: "gear",
  "mappin.and.ellipse": "pin",
};

/** The icon for a row kind or an event name; a lightning bolt for anything the protocol has no symbol for. */
export const kindIcon = (kind: string): IconName => SYMBOLS[EVENT_ICONS[kind] ?? ""] ?? "zap";
export const hasKindIcon = (kind: string) => kind in EVENT_ICONS;
export const kindTint = (kind: string): RowTint => ROW_TINTS[kind] ?? "plain";
