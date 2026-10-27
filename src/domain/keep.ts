import { createHmac, timingSafeEqual } from "node:crypto";
import { bus } from "../core/bus.ts";
import { config } from "../core/config.ts";

/**
 * Keep's webhooks: page events posted to `/keep/events`, signed with the secret Keep showed when the hook was made
 * (`PAI_KEEP_WEBHOOK_SECRETS`, one per workspace hook). They are hints — a session that cares re-reads the page through the Keep MCP — so
 * each becomes one bus event and nothing more.
 */
export interface KeepEvent {
  readonly type: "page.created" | "page.changed" | "page.deleted";
  readonly urn: string;
  readonly workspace: string;
  readonly changed: readonly string[];
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
  bus.emitEvent(`keep.${event.type}`, { urn: event.urn, workspace: event.workspace, changed: event.changed });
  return event;
}
