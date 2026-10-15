import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Real tasks are written, and configuration is frozen at import: a scratch database first.
process.env.PAI_DB = join(mkdtempSync(join(tmpdir(), "pai-watch-")), "pai.db");

const { keep } = await import("./watch.ts");
const tasks = await import("./tasks.ts");

const linkedin = { title: "pai may have stopped seeing LinkedIn", nextAction: "run `pai linkedin status`", by: "linkedin-check" };
const browser = { title: "pai's browser keeps dying", nextAction: "check the daemon log", by: "browser-check" };
const rows = (title: string) => tasks.list({ status: ["inbox", "active", "waiting_user", "waiting_other", "scheduled", "done", "dropped"] }).filter((t) => t.title === title);

describe("the one task an observer keeps", () => {
  const t0 = Date.now();

  test("a fault that comes and goes keeps one row, counting its returns", () => {
    keep(linkedin, "signed out", t0);
    expect(rows(linkedin.title).length).toBe(1);
    const id = rows(linkedin.title)[0]!.id;

    // The same reason again changes nothing; a new reason updates that row in place.
    keep(linkedin, "signed out", t0 + 60_000);
    keep(linkedin, "the last read failed", t0 + 2 * 60_000);
    expect(rows(linkedin.title).length).toBe(1);
    expect(tasks.get(id)!.notes).toContain("the last read failed");

    // Answering again closes it, and the fault returning reopens that same row.
    keep(linkedin, undefined, t0 + 3 * 60_000);
    expect(tasks.get(id)!.status).toBe("done");
    keep(linkedin, "signed out", t0 + 4 * 60_000);
    expect(tasks.get(id)!.status).toBe("inbox");
    expect(tasks.get(id)!.notes).toContain("came back 2 times");

    // Eleven episodes, which is what 12–15 October actually produced, still leave one task.
    for (let i = 5; i < 25; i++) keep(linkedin, i % 2 ? undefined : "signed out", t0 + i * 60_000);
    expect(rows(linkedin.title).length).toBe(1);
  });

  test("each observer keeps its own, and never adopts another's", () => {
    keep(browser, "not answering", t0 + 30 * 60_000);
    expect(rows(browser.title).length).toBe(1);
    expect(rows(linkedin.title).length).toBe(1);
    const theirs = rows(browser.title)[0]!.id;
    keep(browser, undefined, t0 + 31 * 60_000);
    // A different observer's closed task is not the one to reopen, however alike the shape.
    keep(linkedin, "signed out again", t0 + 32 * 60_000);
    expect(tasks.get(theirs)!.status).toBe("done");
  });

  test("older than the window starts a fresh task, and one he dropped is never reopened", () => {
    keep(linkedin, undefined, t0 + 40 * 60_000);
    // The rows' own timestamps are wall-clock, so "older than the window" is read from far enough ahead.
    const later = Date.now() + 60 * 24 * 3600_000;
    keep(linkedin, "signed out", later);
    expect(rows(linkedin.title).length).toBe(2);

    const open = rows(linkedin.title).find((t) => t.status === "inbox")!;
    tasks.update(open.id, { status: "dropped" });
    keep(linkedin, "signed out", later + 60_000);
    expect(tasks.get(open.id)!.status).toBe("dropped");
    expect(rows(linkedin.title).filter((t) => t.status === "inbox").length).toBe(1);
  });
});
