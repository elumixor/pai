import { createHmac, timingSafeEqual } from "node:crypto";
import { bus } from "../core/bus.ts";
import { config } from "../core/config.ts";

/**
 * Keep's webhooks: page events posted to `/keep/events`, signed with the secret Keep showed when the hook was made
 * (`PAI_KEEP_WEBHOOK_SECRETS`, one per workspace hook). They are hints — a session that cares re-reads the page through the Keep MCP — so
 * each becomes one bus event and nothing more. pai's own code reads and writes Keep through the same MCP with the
 * workspace's agent key (`PAI_KEEP_KEYS`, `callKeep`).
 */
export interface KeepEvent {
  readonly type: "page.created" | "page.changed" | "page.deleted";
  readonly urn: string;
  /** The workspace as a URN (`keep:page/<root id>`). */
  readonly workspace: string;
  readonly changed: readonly string[];
  /** The page's own and inherited property values, when Keep sends them. */
  readonly effective?: Record<string, unknown>;
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

/** One Keep MCP tool, as the workspace's agent; the tool's structured result. */
export async function callKeep<T>(workspace: string, tool: string, args: Record<string, unknown>): Promise<T> {
  const key = config.keepKeys[pageId(workspace)];
  if (!key) throw new KeepError(`no PAI_KEEP_KEYS entry for workspace ${pageId(workspace)}`);
  if (!config.keepUrl) throw new KeepError("PAI_KEEP_URL is not set");
  const res = await fetch(`${config.keepUrl.replace(/\/$/, "")}/mcp`, {
    method: "POST",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${key}` },
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

function signedWith(secret: string, body: string, signature: string) {
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  return expected.length === signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

const signed = (body: string, signature: string | null) =>
  Boolean(signature) && config.keepWebhookSecrets.some((secret) => signedWith(secret, body, signature ?? ""));

export function receive(body: string, signature: string | null): KeepEvent {
  if (!signed(body, signature)) throw new KeepSignatureError();
  const event = JSON.parse(body) as KeepEvent;
  bus.emitEvent(`keep.${event.type}`, {
    urn: event.urn,
    workspace: event.workspace,
    changed: event.changed,
    ...(event.effective ? { effective: event.effective } : {}),
  });
  return event;
}
