import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import type { Theme } from "./themes.ts";

/** CodeMirror's colours from a theme: the syntax palette for tokens, the chrome for the rest. */
export function editorTheme(theme: Theme) {
  const s = theme.syntax;
  const u = theme.ui;
  const highlight = HighlightStyle.define([
    { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: s.comment, fontStyle: "italic" },
    { tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword, tags.operatorKeyword, tags.definitionKeyword], color: s.keyword },
    { tag: [tags.string, tags.special(tags.string), tags.character, tags.docString], color: s.string },
    { tag: [tags.number, tags.integer, tags.float, tags.bool, tags.null], color: s.number },
    { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.macroName], color: s.function },
    { tag: [tags.variableName, tags.definition(tags.variableName), tags.local(tags.variableName)], color: s.variable },
    { tag: [tags.typeName, tags.className, tags.namespace, tags.annotation, tags.modifier, tags.self], color: s.type },
    { tag: [tags.propertyName, tags.definition(tags.propertyName), tags.labelName], color: s.property },
    { tag: [tags.operator, tags.arithmeticOperator, tags.logicOperator, tags.compareOperator, tags.updateOperator, tags.definitionOperator, tags.derefOperator], color: s.operator },
    { tag: [tags.punctuation, tags.bracket, tags.paren, tags.brace, tags.squareBracket, tags.separator], color: s.punctuation },
    { tag: [tags.tagName, tags.angleBracket], color: s.tag },
    { tag: [tags.attributeName, tags.attributeValue], color: s.attribute },
    { tag: [tags.constant(tags.variableName), tags.standard(tags.variableName), tags.atom, tags.literal, tags.regexp, tags.escape, tags.color], color: s.constant },
    { tag: [tags.heading, tags.heading1, tags.heading2, tags.heading3], color: s.heading, fontWeight: "bold" },
    { tag: [tags.link, tags.url], color: s.link, textDecoration: "underline" },
    { tag: [tags.invalid, tags.deleted], color: s.invalid },
    { tag: tags.inserted, color: s.string },
    { tag: tags.strong, fontWeight: "bold" },
    { tag: tags.emphasis, fontStyle: "italic" },
    { tag: tags.strikethrough, textDecoration: "line-through" },
    { tag: [tags.meta, tags.processingInstruction, tags.contentSeparator], color: s.comment },
  ]);
  const chrome = EditorView.theme(
    {
      "&": { color: u.text, backgroundColor: u.codeBg },
      ".cm-content": { caretColor: u.accent },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: u.accent },
      "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { backgroundColor: u.selection },
      ".cm-activeLine": { backgroundColor: `${u.line}66` },
      ".cm-activeLineGutter": { backgroundColor: `${u.line}66`, color: u.text },
      ".cm-gutters": { backgroundColor: u.codeBg, color: u.dim, borderRight: `1px solid ${u.line}` },
      ".cm-selectionMatch": { backgroundColor: `${u.accent}33` },
      ".cm-matchingBracket, .cm-nonmatchingBracket": { backgroundColor: `${u.accent}33`, outline: "none" },
      ".cm-searchMatch": { backgroundColor: `${u.busy}55` },
      ".cm-foldPlaceholder": { backgroundColor: u.panel2, border: "none", color: u.dim },
      ".cm-panels": { backgroundColor: u.panel, color: u.text },
      ".cm-tooltip": { backgroundColor: u.panel, border: `1px solid ${u.line2}` },
      ".cm-fat-cursor": { backgroundColor: `${u.accent}aa`, color: u.accentInk },
      "&:not(.cm-focused) .cm-fat-cursor": { outline: `1px solid ${u.accent}` },
    },
    { dark: theme.kind === "dark" },
  );
  return [syntaxHighlighting(highlight), chrome];
}

/** xterm's colours from a theme. */
export function terminalTheme(theme: Theme) {
  const [black, red, green, yellow, blue, magenta, cyan, white, brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite] = theme.terminal;
  return {
    background: theme.ui.codeBg,
    foreground: theme.ui.text,
    cursor: theme.ui.accent,
    selectionBackground: theme.ui.selection,
    black, red, green, yellow, blue, magenta, cyan, white, brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite,
  };
}
