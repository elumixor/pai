import { createHmac, timingSafeEqual } from "node:crypto";
import { bus } from "../core/bus.ts";
import { config } from "../core/config.ts";

/**
 * Keep's webhooks: page and comment events posted to `/keep/events`, signed with the secret Keep showed when the hook
 * was made (`PAI_KEEP_WEBHOOK_SECRETS`, one per hook). They are hints — a session that cares re-reads the page through
 * the Keep MCP — so each becomes one bus event and nothing more. pai's own code reads and writes Keep through the same
 * MCP as Pai's Keep account (`PAI_KEEP_KEY`, `callKeep`), tagging each write with a client (`x-keep-client`).
 */
export type KeepEventType = "page.created" | "page.changed" | "page.deleted" | "comment.created" | "comment.changed" | "comment.deleted";

/** One item of a change's diff, as Keep and People describe it. */
export interface KeepChange {
  readonly kind: "title" | "body" | "property" | "comment" | "child-added" | "child-removed" | "trashed" | "restored";
  readonly name?: string;
  readonly summary: string;
}

/** Keep's webhook body. v2 adds every field marked optional here; a v1 body still parses. */
export interface KeepEvent {
  readonly version?: 2;
  readonly id?: string;
  readonly ts?: string;
  readonly type: KeepEventType;
  /** The subject: `keep:page/<id>`, or `keep:comment/<id>` for comment events. */
  readonly urn: string;
  /** The page the event is about (`keep:page/<id>`); v1 had only `urn`. */
  readonly page?: string;
  /** The workspace as a URN (`keep:page/<root id>`). */
  readonly workspace: string;
  /** Who wrote (`people:person/<id>`). */
  readonly actor?: string;
  /** The write's `x-keep-client` tag. */
  readonly client?: string;
  readonly changed: readonly string[];
  readonly changes?: readonly KeepChange[];
  readonly schema?: unknown;
  readonly traits?: readonly string[];
  /** The page's own property values, by name. */
  readonly properties?: Record<string, unknown>;
  /** The page's own and inherited property values, when Keep sends them. */
  readonly effective?: Record<string, unknown>;
  readonly comment?: { readonly id: string; readonly body: string; readonly author?: string; readonly replyTo?: string | null };
}

const TIMEOUT_MS = 10_000;

export class KeepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeepError";
  }
}

/** The bare id of a `keep:page/<id>` URN (or an id already). */
export const pageId = (urn: string) => urn.replace(/^keep:page\//, "");

/** The client tag daemon-side writes carry when the caller names none. */
const DAEMON_CLIENT = "pai:daemon";

/** One Keep MCP tool, as Pai's Keep account; the tool's structured result. `client` tags the write (`x-keep-client`). */
export async function callKeep<T>(tool: string, args: Record<string, unknown>, opts: { client?: string } = {}): Promise<T> {
  const key = config.keepKey;
  if (!key) throw new KeepError("PAI_KEEP_KEY is not set");
  if (!config.keepUrl) throw new KeepError("PAI_KEEP_URL is not set");
  const res = await fetch(`${config.keepUrl.replace(/\/$/, "")}/mcp`, {
    method: "POST",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${key}`, "x-keep-client": opts.client ?? DAEMON_CLIENT },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  const reply = (await res.json().catch(() => ({}))) as {
    error?: { message: string };
    result?: { isError?: boolean; structuredContent?: T; content?: { text?: string }[] };
  };
  if (!res.ok || reply.error) throw new KeepError(`${tool}: ${reply.error?.message ?? res.status}`);
  const text = reply.result?.content?.[0]?.text ?? "";
  if (reply.result?.isError) throw new KeepError(`${tool}: ${text}`);
  return reply.result?.structuredContent ?? (JSON.parse(text || "null") as T);
}

export class KeepSignatureError extends Error {
  constructor() {
    super("the body is not signed with any of PAI_KEEP_WEBHOOK_SECRETS");
    this.name = "KeepSignatureError";
  }
}

/** Whether `signature` (`sha256=<hex>`) is the HMAC of `body` with `secret`. */
export function signedWith(secret: string, body: string, signature: string) {
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  return expected.length === signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

const signed = (body: string, signature: string | null) =>
  Boolean(signature) && config.keepWebhookSecrets.some((secret) => signedWith(secret, body, signature ?? ""));

export function receive(body: string, signature: string | null): KeepEvent {
  if (!signed(body, signature)) throw new KeepSignatureError();
  const event = JSON.parse(body) as KeepEvent;
  const effective = event.effective ?? event.properties;
  bus.emitEvent(`keep.${event.type}`, {
    ...(event.id ? { id: event.id } : {}),
    urn: event.urn,
    page: event.page ?? event.urn,
    workspace: event.workspace,
    ...(event.actor ? { actor: event.actor } : {}),
    ...(event.client ? { client: event.client } : {}),
    changed: event.changed,
    ...(event.changes ? { changes: event.changes } : {}),
    ...(event.comment ? { comment: event.comment } : {}),
    ...(effective ? { effective } : {}),
  });
  return event;
}
