import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PAI_DB = join(mkdtempSync(join(tmpdir(), "pai-reads-")), "pai.db");
const { mark, marks } = await import("./reads.ts");

describe("how far he has read", () => {
  test("a place remembers the newest thing he saw", () => {
    mark("chat:pai", 1000);
    expect(marks()["chat:pai"]).toBe(1000);
  });

  test("it only moves forward, so two clients cannot undo each other", () => {
    mark("chat:pai", 2000);
    mark("chat:pai", 1500);
    expect(marks()["chat:pai"]).toBe(2000);
  });

  test("places are separate, and nonsense changes nothing", () => {
    mark("notices", 500);
    mark("", 9000);
    mark("chat:hiring", Number.NaN);
    expect(marks()).toEqual({ "chat:pai": 2000, notices: 500 });
  });
});
