import { createHmac, timingSafeEqual } from "node:crypto";
import { bus } from "../core/bus.ts";
import { config } from "../core/config.ts";

/**
 * Kip's webhooks: page events posted to `/kip/events`, signed with the secret Kip showed when the hook was made
 * (`PAI_KIP_WEBHOOK_SECRETS`, one per workspace hook). They are hints — a session that cares re-reads the page through the Kip MCP — so
 * each becomes one bus event and nothing more.
 */
export interface KipEvent {
  readonly type: "page.created" | "page.changed" | "page.deleted";
  readonly urn: string;
  readonly workspace: string;
  readonly changed: readonly string[];
}

export class KipSignatureError extends Error {
  constructor() {
    super("the body is not signed with any of PAI_KIP_WEBHOOK_SECRETS");
    this.name = "KipSignatureError";
  }
}

function signedWith(secret: string, body: string, signature: string) {
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  return expected.length === signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

const signed = (body: string, signature: string | null) =>
  Boolean(signature) && config.kipWebhookSecrets.some((secret) => signedWith(secret, body, signature ?? ""));

export function receive(body: string, signature: string | null): KipEvent {
  if (!signed(body, signature)) throw new KipSignatureError();
  const event = JSON.parse(body) as KipEvent;
  bus.emitEvent(`kip.${event.type}`, { urn: event.urn, workspace: event.workspace, changed: event.changed });
  return event;
}
