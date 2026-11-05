/**
 * What a theme can change. Tokens are the variables the whole app reads. Elements are single things on the page.
 * An element's selector is raised one class above the rule it overrides in `pai.css` and stays below that rule's state
 * variants (a tint, an answered question), so those keep working. Where a state would still be lost, the
 * property goes through a variable instead (`vars`), which every state reads.
 */

export type TokenKind = "color" | "font" | "size";

interface TokenDef {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly kind: TokenKind;
  readonly vars: readonly string[];
  /** A size's line height, and the ratio to the size it keeps. */
  readonly lineHeight?: { readonly name: string; readonly ratio: number };
}

const color = (id: string, label: string, group: string, ...vars: string[]) => ({ id, label, group, kind: "color", vars }) as const;

export const TOKENS = [
  color("page", "Page", "Backgrounds", "--page"),
  color("sidebar", "Sidebar", "Backgrounds", "--sidebar"),
  color("surface", "Surface", "Backgrounds", "--surface", "--panel"),
  color("raised", "Raised surface", "Backgrounds", "--surface-2", "--panel-2"),
  color("text", "Text", "Text and lines", "--text"),
  color("dim", "Quiet text", "Text and lines", "--dim"),
  color("line", "Lines", "Text and lines", "--line", "--line-2"),
  color("accent", "Accent", "Accent", "--accent"),
  color("accentInk", "Text on accent", "Accent", "--accent-ink"),
  color("selection", "Selection", "Accent", "--selection"),
  color("act", "Action", "Actions", "--act"),
  color("actButton", "Action button", "Actions", "--act-btn"),
  color("actInk", "Text on action", "Actions", "--act-ink"),
  color("hand", "Waiting on you", "Actions", "--hand"),
  color("ok", "Done", "States", "--ok", "--idle"),
  color("busy", "Working", "States", "--busy"),
  color("warn", "Warning", "States", "--warn"),
  color("hot", "Failed", "States", "--hot"),
  color("model", "Model", "States", "--model"),
  color("effort", "Effort", "States", "--effort"),
  { id: "fontUi", label: "Interface font", group: "Type", kind: "font", vars: ["--font-ui"] },
  { id: "fontBody", label: "Message font", group: "Type", kind: "font", vars: ["--font-body"] },
  { id: "fontCode", label: "Code font", group: "Type", kind: "font", vars: ["--mono"] },
  { id: "sizeUi", label: "Interface size", group: "Type", kind: "size", vars: ["--ui"], lineHeight: { name: "--ui-lh", ratio: 20 / 14 } },
  { id: "sizeBody", label: "Message size", group: "Type", kind: "size", vars: ["--body"], lineHeight: { name: "--body-lh", ratio: 22 / 15 } },
  { id: "sizeMeta", label: "Small size", group: "Type", kind: "size", vars: ["--meta"], lineHeight: { name: "--meta-lh", ratio: 14 / 11 } },
] as const satisfies readonly TokenDef[];

export type TokenId = (typeof TOKENS)[number]["id"];

export type ElementProp = "color" | "background" | "font" | "size" | "weight" | "italic" | "underline";

interface ElementDef {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly offers: readonly ElementProp[];
  readonly selector?: string;
  readonly vars?: Partial<Record<ElementProp, string>>;
  /** Drawn at reduced opacity by `pai.css`: a colour chosen for it has to show as chosen. */
  readonly opaque?: boolean;
  /** How it looks untouched, where that is not plain text. */
  readonly looks?: { readonly weight?: number; readonly italic?: boolean; readonly underline?: boolean };
}

const TEXT = ["color", "font", "size", "weight", "italic", "underline"] as const;
const BOX = [...TEXT, "background"] as const;

export const ELEMENTS = [
  { id: "assistant", label: "Assistant message", group: "Messages", offers: TEXT, selector: ".row.reply .bubble" },
  // No size: folding a long message counts lines of --body-lh. The message size token moves both.
  { id: "mine", label: "Your message", group: "Messages", offers: ["color", "background", "font", "weight", "italic"], selector: ".row.mine .mine-text", vars: { background: "--mine-bg" } },
  { id: "heading", label: "Heading", group: "Messages", offers: TEXT, selector: ".row.reply .bubble .md-h", opaque: true, looks: { weight: 700 } },
  { id: "bold", label: "Bold", group: "Messages", offers: ["color", "font", "weight", "italic", "underline"], selector: ".row.reply .bubble strong, .q-body strong", opaque: true, looks: { weight: 700 } },
  { id: "italic", label: "Italic", group: "Messages", offers: ["color", "font", "weight", "italic", "underline"], selector: ".row.reply .bubble em, .q-body em", looks: { italic: true } },
  { id: "link", label: "Link", group: "Messages", offers: ["color", "font", "weight", "italic", "underline"], selector: ".row.reply .bubble a, .q-body a" },
  { id: "inlineCode", label: "Inline code", group: "Messages", offers: BOX, selector: ".md-inline.md-inline" },
  { id: "codeBlock", label: "Code block", group: "Messages", offers: BOX, selector: ".row.reply .bubble .md-code, .q-body .md-code.md-code" },
  { id: "quote", label: "Quote", group: "Messages", offers: TEXT, selector: ".md-quote.md-quote" },
  { id: "question", label: "Question", group: "Messages", offers: TEXT, selector: ".q-body.q-body" },
  { id: "toolLine", label: "Activity line", group: "Activity", offers: TEXT, selector: ".pill-line.pill-line, .row.group .pill-line.pill-line, .row.tools .tools-head.tools-head" },
  { id: "toolCall", label: "Tool name", group: "Activity", offers: TEXT, selector: ".tool-call-what.tool-call-what", looks: { weight: 500 } },
  { id: "time", label: "Time", group: "Activity", offers: TEXT, selector: ".row-foot time, .inline-time.inline-time, .pill-line .when.when, .row.question.question time" },
  { id: "day", label: "Day label", group: "Activity", offers: BOX, selector: ".day.day, .chat-daypill.chat-daypill", vars: { background: "--pill-bg" } },
  { id: "option", label: "Answer button", group: "Activity", offers: BOX, selector: ".opt.opt", vars: { color: "--act-ink", background: "--act-btn" }, looks: { weight: 700 } },
  { id: "compose", label: "Message box", group: "Frame", offers: BOX, selector: ".chat-compose .input.input", vars: { background: "--compose-bg" } },
  { id: "treeRow", label: "Sidebar row", group: "Frame", offers: TEXT, selector: ".tree-label.tree-label", vars: { color: "--tree-ink", size: "--tree-size" } },
  { id: "treeActive", label: "Open sidebar row", group: "Frame", offers: ["color", "background"], vars: { color: "--tree-ink-on", background: "--tree-bg-on" } },
] as const satisfies readonly ElementDef[];

export type ElementId = (typeof ELEMENTS)[number]["id"];

export const elementDef = (id: ElementId): ElementDef => {
  const def = ELEMENTS.find((element) => element.id === id);
  if (!def) throw new Error(`unknown element: ${id}`);
  return def;
};

/** Only what the machine has: Inter is the one web font the app loads. Any other installed name can be typed. */
export const FONTS: readonly { readonly name: string; readonly stack: string }[] = [
  { name: "Inter", stack: `"Inter", -apple-system, BlinkMacSystemFont, system-ui, sans-serif` },
  { name: "System", stack: `-apple-system, BlinkMacSystemFont, system-ui, sans-serif` },
  { name: "SF Pro Rounded", stack: `"SF Pro Rounded", ui-rounded, -apple-system, system-ui, sans-serif` },
  { name: "Helvetica Neue", stack: `"Helvetica Neue", Helvetica, Arial, sans-serif` },
  { name: "Avenir Next", stack: `"Avenir Next", Avenir, system-ui, sans-serif` },
  { name: "New York", stack: `"New York", ui-serif, Georgia, serif` },
  { name: "Georgia", stack: `Georgia, serif` },
  { name: "Charter", stack: `Charter, "Bitstream Charter", Georgia, serif` },
  { name: "Iowan Old Style", stack: `"Iowan Old Style", Palatino, Georgia, serif` },
  { name: "SF Mono", stack: `ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace` },
  { name: "Menlo", stack: `Menlo, Consolas, monospace` },
  { name: "JetBrains Mono", stack: `"JetBrains Mono", ui-monospace, Menlo, monospace` },
];

export const SIZE_RANGE = { min: 9, max: 32 } as const;
