/**
 * Structured metadata that rides along with a chat message.
 *
 * A message has to read correctly in a stock Telegram client, so the metadata cannot be
 * a custom entity or a hidden character sequence: those either get stripped or show up as
 * mojibake. It travels instead as a trailing link, which every client renders as a link
 * and our own client parses and hides.
 */

export const PROTOCOL_VERSION = 1;

/** What the trailer's anchor text looks like in a client that does not understand it. */
export const MARKER = "·";

/** Telegram's message limit is 4096; the trailer may not crowd out the message itself. */
export const MAX_PAYLOAD_CHARS = 2048;

export type RichKind = "turn" | "status" | "question" | "result";

export interface RichTool {
  readonly name: string;
  readonly detail?: string;
}

export interface RichUsage {
  readonly input: number;
  readonly output: number;
}

export interface RichMeta {
  readonly v: typeof PROTOCOL_VERSION;
  readonly kind: RichKind;
  readonly session: string;
  readonly project?: string;
  readonly tools?: readonly RichTool[];
  readonly usage?: RichUsage;
  readonly durationMs?: number;
}

export class RichProtocolError extends Error {
  constructor(message: string, readonly payload?: string) {
    super(message);
    this.name = "RichProtocolError";
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(text: string) {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export function encodePayload(meta: RichMeta) {
  const payload = toBase64Url(encoder.encode(JSON.stringify(meta)));
  if (payload.length > MAX_PAYLOAD_CHARS)
    throw new RichProtocolError(`metadata too large: ${payload.length} chars`, payload);
  return payload;
}

export function decodePayload(payload: string): RichMeta {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(fromBase64Url(payload)));
  } catch (cause) {
    throw new RichProtocolError(`payload is not valid metadata: ${(cause as Error).message}`, payload);
  }
  const meta = parsed as RichMeta;
  if (meta?.v !== PROTOCOL_VERSION) throw new RichProtocolError(`unsupported protocol version: ${meta?.v}`, payload);
  if (!meta.session) throw new RichProtocolError("metadata has no session", payload);
  return meta;
}

const escapes: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

/** Telegram's HTML parse mode only allows a handful of tags, and only these three escapes. */
export function escapeHtml(text: string) {
  return text.replace(/[&<>]/g, (c) => escapes[c] ?? c);
}

export function trailerUrl(baseUrl: string, meta: RichMeta) {
  return `${baseUrl.replace(/\/$/, "")}/m/${encodePayload(meta)}`;
}

/** The message as a stock client sees it: the text, then one small link. */
export function encodeMessage(text: string, meta: RichMeta, baseUrl: string) {
  return `${escapeHtml(text)} <a href="${trailerUrl(baseUrl, meta)}">${MARKER}</a>`;
}

const TRAILER = /\s*<a href="[^"]*\/m\/([A-Za-z0-9_-]+)">.<\/a>\s*$/;

export interface DecodedMessage {
  readonly text: string;
  readonly meta?: RichMeta;
}

/**
 * Splits a message back into what to show and what to render from. A message without a
 * trailer, or with one this version cannot read, still yields its text: a client that
 * fails to parse metadata must not fail to show the message.
 */
export function decodeMessage(html: string): DecodedMessage {
  const match = TRAILER.exec(html);
  if (!match?.[1]) return { text: html };
  const text = html.slice(0, match.index);
  try {
    return { text, meta: decodePayload(match[1]) };
  } catch {
    return { text };
  }
}
