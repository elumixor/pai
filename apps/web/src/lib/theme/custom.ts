import { type ElementId, type ElementProp, elementDef, ELEMENTS, FONTS, SIZE_RANGE, type TokenId, TOKENS } from "./catalog";

export interface ElementStyle {
  readonly color?: string;
  readonly background?: string;
  readonly font?: string;
  readonly size?: number;
  readonly weight?: number;
  readonly italic?: boolean;
  readonly underline?: boolean;
}

/** A theme of one's own: a built-in palette with changes on it. Its light or dark is always the base's. */
export interface CustomTheme {
  readonly id: string;
  readonly name: string;
  readonly base: string;
  readonly tokens: Readonly<Partial<Record<TokenId, string>>>;
  readonly elements: Readonly<Partial<Record<ElementId, ElementStyle>>>;
}

export const isCustomId = (id: string) => id.startsWith("custom-");

/** No character that could end a declaration, a rule or the style element: themes come back from storage. */
const SAFE_COLOR = /^[#\w\s(),.%/-]+$/;
const SAFE_FONT = /^[\w .-]+$/;
const ELEMENT_LINE_HEIGHT = 1.45;

const colorValue = (value: string | undefined) => (value && SAFE_COLOR.test(value) ? value : undefined);

export function fontStack(name: string | undefined) {
  if (!name || !SAFE_FONT.test(name)) return undefined;
  return FONTS.find((font) => font.name === name)?.stack ?? `"${name}", sans-serif`;
}

function sizeValue(size: string | number | undefined) {
  const px = Number(size);
  return size !== undefined && Number.isFinite(px) ? Math.min(SIZE_RANGE.max, Math.max(SIZE_RANGE.min, px)) : undefined;
}

function tokenDeclarations({ tokens }: CustomTheme): string[] {
  return TOKENS.flatMap((token) => {
    const raw = tokens[token.id];
    if (token.kind === "size") {
      const px = sizeValue(raw);
      if (px === undefined) return [];
      return [`${token.vars[0]}:${px}px`, `${token.lineHeight.name}:${Math.round(px * token.lineHeight.ratio)}px`];
    }
    const value = token.kind === "font" ? fontStack(raw) : colorValue(raw);
    return value ? token.vars.map((name) => `${name}:${value}`) : [];
  });
}

function propertyDeclarations(prop: ElementProp, style: ElementStyle, opaque: boolean): string[] {
  switch (prop) {
    case "color": {
      const value = colorValue(style.color);
      return value ? [`color:${value}`, ...(opaque ? ["opacity:1"] : [])] : [];
    }
    case "background": {
      const value = colorValue(style.background);
      return value ? [`background:${value}`] : [];
    }
    case "font": {
      const value = fontStack(style.font);
      return value ? [`font-family:${value}`] : [];
    }
    case "size": {
      const px = sizeValue(style.size);
      return px === undefined ? [] : [`font-size:${px}px`, `line-height:${ELEMENT_LINE_HEIGHT}`];
    }
    case "weight":
      return Number.isFinite(style.weight) ? [`font-weight:${style.weight}`] : [];
    case "italic":
      return style.italic === undefined ? [] : [`font-style:${style.italic ? "italic" : "normal"}`];
    case "underline":
      return style.underline === undefined ? [] : [`text-decoration:${style.underline ? "underline" : "none"}`];
  }
}

function variableValue(prop: ElementProp, style: ElementStyle) {
  if (prop === "color") return colorValue(style.color);
  if (prop === "background") return colorValue(style.background);
  const px = prop === "size" ? sizeValue(style.size) : undefined;
  return px === undefined ? undefined : `${px}px`;
}

/**
 * The CSS for a theme. Tokens need three `:root`s to beat `:root[data-palette]` in the unlayered tokens.css. Elements
 * stay inside the `pai` layer: an unlayered rule would beat every state of what it styles.
 */
export function compileTheme(theme: CustomTheme): string {
  const variables = tokenDeclarations(theme);
  const rules: string[] = [];
  for (const { id } of ELEMENTS) {
    const style = theme.elements[id];
    if (!style) continue;
    const def = elementDef(id);
    const declarations: string[] = [];
    for (const prop of def.offers) {
      const variable = def.vars?.[prop];
      const value = variable ? variableValue(prop, style) : undefined;
      if (variable) {
        if (value) variables.push(`${variable}:${value}`);
      } else {
        declarations.push(...propertyDeclarations(prop, style, def.opaque === true));
      }
    }
    if (def.selector && declarations.length) rules.push(`${def.selector}{${declarations.join(";")}}`);
  }
  return [variables.length ? `:root:root:root{${variables.join(";")}}` : "", rules.length ? `@layer pai{${rules.join("")}}` : ""].join("");
}

/** The base's swatch with the theme's own colours laid over it: canvas, surface, line, ink, accent. */
export function swatchOf({ tokens }: CustomTheme, base: readonly [string, string, string, string, string]): readonly [string, string, string, string, string] {
  return [tokens.sidebar ?? base[0], tokens.page ?? tokens.surface ?? base[1], tokens.line ?? base[2], tokens.text ?? base[3], tokens.accent ?? base[4]];
}
