import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Configuration is read once, at import: a scratch database first.
process.env.PAI_DB = join(mkdtempSync(join(tmpdir(), "pai-tasks-")), "pai.db");

const { firstUrl } = await import("./tasks.ts");

describe("firstUrl", () => {
  test("takes a bare url out of a sentence, without the punctuation that ends it", () => {
    expect(firstUrl("book a slot at https://cal.example.com/vlad?x=1.")).toBe("https://cal.example.com/vlad?x=1");
    expect(firstUrl("see (https://example.com/a) for the form")).toBe("https://example.com/a");
  });

  test("prefers the target of a markdown link over its text", () => {
    expect(firstUrl("[book the interview](https://ashby.example/app/42)")).toBe("https://ashby.example/app/42");
  });

  test("falls through its arguments in order and gives nothing when there is no link", () => {
    expect(firstUrl(null, "", "then https://b.test/x")).toBe("https://b.test/x");
    expect(firstUrl("reply to Anna", undefined, null)).toBeUndefined();
    expect(firstUrl()).toBeUndefined();
  });
});
