import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Configuration is frozen at import: a scratch database first.
const scratch = mkdtempSync(join(tmpdir(), "pai-drafts-"));
process.env.PAI_WORKSPACE = join(scratch, "workspace");
process.env.PAI_DB = join(scratch, "pai.db");

const { bus } = await import("../core/bus.ts");
const { db } = await import("../core/db.ts");
const drafts = await import("./drafts.ts");
const messages = await import("./messages.ts");

type Fields = Parameters<typeof drafts.offer>[0]["fields"];
type Channel = Parameters<typeof drafts.offer>[0]["channel"];

const offer = (over: Partial<Fields> = {}, channel: Channel = "email") =>
  drafts.offer({ agent: "hiring", channel, fields: { to: "someone@example.com", subject: "Interview", body: "Ahoj, můžeme ve čtvrtek?", ...over } });

beforeEach(() => {
  db.exec("DELETE FROM drafts; DELETE FROM messages");
});

describe("a draft is a row of its own, and a row in the chat", () => {
  test("offering one leaves a card to draw and a chat row that says the same", () => {
    const draft = offer();
    expect(draft.status).toBe("pending");
    expect(draft.messageId).not.toBeNull();
    const row = messages.get(draft.messageId!)!;
    expect(row.meta.draftId).toBe(draft.id);
    expect(row.body).toContain("Ahoj, můžeme ve čtvrtek?");
    expect(row.body).toContain("to: someone@example.com");
  });

  test("a channel's own fields are required, and nothing else is", () => {
    expect(() => drafts.offer({ agent: "hiring", channel: "email", fields: { body: "hi" } })).toThrow(/needs to/);
    expect(drafts.offer({ agent: "atma", channel: "post", fields: { body: "We are hiring." } }).status).toBe("pending");
    expect(() => drafts.offer({ agent: "hiring", channel: "whatsapp", fields: { body: "   " } })).toThrow(/not a draft/);
  });
});

describe("the card is the approval", () => {
  test("what the wake carries is what the card holds, not what the agent wrote", () => {
    const draft = offer();
    drafts.edit(draft.id, { body: "Ahoj, můžeme v pátek v 9:00?", subject: "Interview — Friday" });
    const text = drafts.wakeText(drafts.get(draft.id)!);
    expect(text).toContain("v pátek v 9:00");
    expect(text).not.toContain("ve čtvrtek");
    expect(text).toContain("Interview — Friday");
    expect(text).toContain("gmail_send");
    expect(text).toContain("draft_result");
  });

  test("his edit reaches the chat row too, so no client shows the old words", () => {
    const draft = offer();
    drafts.edit(draft.id, { body: "A different message entirely." });
    expect(messages.get(draft.messageId!)!.body).toContain("A different message entirely.");
  });

  test("the send asks the owning agent, by name, with the text", () => {
    const draft = offer();
    const seen: Record<string, unknown>[] = [];
    const watch = (e: { kind: string; payload: Record<string, unknown> }) => (e.kind === "draft.sending" ? void seen.push(e.payload) : undefined);
    bus.on("event", watch);
    drafts.send(draft.id);
    bus.off("event", watch);
    expect(drafts.get(draft.id)!.status).toBe("sending");
    expect(seen[0]?.agent).toBe("hiring");
    expect(String(seen[0]?.text)).toContain("Ahoj, můžeme ve čtvrtek?");
  });

  test("a draft already going cannot be edited or sent twice", () => {
    const draft = offer();
    drafts.send(draft.id);
    expect(() => drafts.edit(draft.id, { body: "too late" })).toThrow(/cannot be changed/);
    expect(() => drafts.send(draft.id)).toThrow(/sending/);
    expect(() => drafts.discard(draft.id)).toThrow(/too late/);
  });
});

describe("what became of it", () => {
  test("the three states land on the card, in the channel's own words", () => {
    const draft = offer();
    drafts.send(draft.id);
    const sent = drafts.result(draft.id, "unverified", "LinkedIn took it; the thread did not show it");
    expect(sent.status).toBe("sent");
    expect(sent.state).toBe("unverified");
    expect(messages.get(draft.messageId!)!.body).toContain("unverified");
  });

  test("not_sent is a failure, and says so", () => {
    const draft = offer();
    drafts.send(draft.id);
    expect(drafts.result(draft.id, "not_sent", "no such mailbox").status).toBe("failed");
  });

  test("discarded before it goes anywhere, and the agent is told", () => {
    const draft = offer();
    const seen: Record<string, unknown>[] = [];
    const watch = (e: { kind: string; payload: Record<string, unknown> }) => (e.kind === "draft.discarded" ? void seen.push(e.payload) : undefined);
    bus.on("event", watch);
    drafts.discard(draft.id, "not now");
    bus.off("event", watch);
    expect(drafts.get(draft.id)!.status).toBe("dropped");
    expect(seen[0]?.agent).toBe("hiring");
    expect(drafts.open()).toEqual([]);
  });
});
