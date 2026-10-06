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

/**
 * `user`: what the user typed somewhere else (a terminal), shown as their own message.
 * The rest come from the message log (pai and its agents): `event` is one service row, `events`
 * a folded run of them; `delegation` a card for work handed to an agent, with its live status;
 * `report` what an agent said back; `ask` a question with buttons; `notice` something to know.
 */
export type RichKind = "turn" | "status" | "question" | "result" | "user" | "event" | "events" | "delegation" | "report" | "ask" | "notice";

export type RichState = "starting" | "busy" | "idle" | "waiting" | "dead" | "error";

export interface RichTool {
  readonly name: string;
  readonly detail?: string;
}

/** One row of a folded run of events. */
export interface RichEvent {
  readonly event: string;
  readonly text: string;
  readonly icon: string;
  readonly agent?: string;
}

/** The SF Symbol each kind of row is drawn with, here so every client draws the same one. */
export const EVENT_ICONS: Readonly<Record<string, string>> = {
  "agent.created": "person.crop.circle.badge.plus",
  "agent.spawned": "arrow.triangle.branch",
  delegate: "arrow.turn.down.right",
  request: "arrow.turn.down.right",
  report: "arrow.turn.up.left",
  response: "arrow.turn.up.left",
  "agent.woken": "bolt",
  "routine.fired": "clock.arrow.circlepath",
  "item.arrived": "envelope",
  "item.telegram": "bubble.left",
  "item.linkedin": "bubble.left",
  "calendar.upcoming": "calendar",
  ask: "questionmark.bubble",
  approval: "hand.raised",
  answered: "checkmark.bubble",
  sent: "paperplane",
  notice: "bell",
  error: "exclamationmark.triangle",
  stopped: "stop.circle",
  "agent.closed": "archivebox",
  "agent.tools_missing": "exclamationmark.triangle",
};

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
  /** A status card: what the session is doing right now. */
  readonly state?: RichState;
  readonly tool?: string;
  readonly startedAt?: number;
  /** Rows from the message log: the agent it is about, its display name and where it sits (`pai › Hiring`). */
  readonly agent?: string;
  readonly agentName?: string;
  readonly breadcrumb?: string;
  /** An event row: what happened and its icon. */
  readonly event?: string;
  readonly icon?: string;
  /** A folded run of events. */
  readonly items?: readonly RichEvent[];
  /** A delegation card: the agent's status now (idle, queued, working, waiting, closed). */
  readonly status?: string;
  /** An ask card. */
  readonly askId?: number;
  readonly options?: readonly string[];
  readonly answer?: string;
  readonly priority?: string;
  /** The forum topic the agent's chat is in, so a client can open it. */
  readonly thread?: number;
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

/**
 * The metadata made small enough for a trailer: a long turn's tool list loses its details first, then its
 * oldest tools, a long fold its oldest events — the rest of the row (state, duration, the agent) always fits.
 */
export function fit(meta: RichMeta): RichMeta {
  const size = (m: RichMeta) => toBase64Url(encoder.encode(JSON.stringify(m))).length;
  if (size(meta) <= MAX_PAYLOAD_CHARS) return meta;
  let tools = meta.tools?.map((t) => ({ ...t, detail: t.detail && t.detail.length > 60 ? `${t.detail.slice(0, 59)}…` : t.detail }));
  let items = meta.items;
  let fitted: RichMeta = { ...meta, ...(tools ? { tools } : {}) };
  while (size(fitted) > MAX_PAYLOAD_CHARS && ((tools?.length ?? 0) > 1 || (items?.length ?? 0) > 1)) {
    if ((tools?.length ?? 0) > 1) tools = tools!.slice(-Math.floor(tools!.length * 0.7));
    if ((items?.length ?? 0) > 1) items = items!.slice(-Math.floor(items!.length * 0.7));
    fitted = { ...meta, ...(tools ? { tools } : {}), ...(items ? { items } : {}) };
  }
  return fitted;
}

export function trailerUrl(baseUrl: string, meta: RichMeta) {
  return `${baseUrl.replace(/\/$/, "")}/m/${encodePayload(fit(meta))}`;
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
