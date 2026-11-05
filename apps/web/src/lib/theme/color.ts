/** Colours as the page has them. Most tokens are `color-mix()` or translucent, which a native colour input cannot hold. */

export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

const TRANSPARENT: Rgba = { r: 0, g: 0, b: 0, a: 0 };
const ALPHA_STEPS = 100;
const RGB = /^rgba?\((\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)(?:[,/\s]+(\d*\.?\d+))?\)$/;

export const isColor = (value: string) => CSS.supports("color", value);

const byte = (value: number) => Math.round(value).toString(16).padStart(2, "0");

export const toHex = ({ r, g, b }: Rgba) => `#${byte(r)}${byte(g)}${byte(b)}`;

/** Opaque as `#rrggbb`, otherwise with its alpha: the form every field and the swatch can read back. */
export const toCss = (color: Rgba) => (color.a >= 1 ? toHex(color) : `${toHex(color)}${byte(color.a * 255)}`);

export function fromHex(hex: string, a: number): Rgba {
  const value = Number.parseInt(hex.slice(1), 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255, a };
}

/** A serialised colour in any notation, painted on one pixel: what the browser itself says it comes to. */
function painted(serialised: string): Rgba {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return TRANSPARENT;
  context.fillStyle = serialised;
  context.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(0, 0, 1, 1).data;
  return { r, g, b, a: Math.round((a / 255) * ALPHA_STEPS) / ALPHA_STEPS };
}

function parse(serialised: string): Rgba {
  const match = RGB.exec(serialised);
  return match ? { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]), a: match[4] === undefined ? 1 : Number(match[4]) } : painted(serialised);
}

/** Any colour the page understands, `var()` and `color-mix()` included, as plain channels. */
export function resolveColor(value: string): Rgba {
  if (!isColor(value)) return TRANSPARENT;
  const probe = document.createElement("span");
  probe.style.color = value;
  document.documentElement.append(probe);
  const { color } = getComputedStyle(probe);
  probe.remove();
  return parse(color);
}
