import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "pai-kip-"));
process.env.PAI_DB = join(scratch, "pai.db");
process.env.PAI_CONFIG = join(scratch, "config.json");
process.env.PAI_KIP_WEBHOOK_SECRETS = "other-workspace, hook-secret";

const { receive, KipSignatureError } = await import("./kip.ts");
const { bus } = await import("../core/bus.ts");

const body = JSON.stringify({ type: "page.changed", urn: "kip:page/1", workspace: "kip:page/2", changed: ["title"] });
const sign = (text: string, secret = "hook-secret") => `sha256=${createHmac("sha256", secret).update(text).digest("hex")}`;

describe("kip webhooks", () => {
  it("puts a signed event on the bus", () => {
    const seen: string[] = [];
    const listener = (e: { kind: string }) => seen.push(e.kind);
    bus.on("event", listener);
    expect(receive(body, sign(body)).urn).toBe("kip:page/1");
    bus.off("event", listener);
    expect(seen).toContain("kip.page.changed");
  });

  it("refuses an unsigned or wrongly signed one", () => {
    expect(() => receive(body, null)).toThrow(KipSignatureError);
    expect(() => receive(body, sign(body, "wrong"))).toThrow(KipSignatureError);
  });
});
