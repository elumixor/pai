import { describe, expect, test } from "bun:test";
import { unwell, type Signal } from "./browser-check.ts";

const live = (over: Partial<Signal> = {}): Signal => ({ answering: true, probeMs: 12, restarts: 0, upMs: 30 * 60_000, ...over });

describe("the browser server", () => {
  test("a server that does not answer says why the symptom is a hang", () => {
    const reason = unwell(live({ answering: false, probeMs: 5000, probeError: "The operation timed out." }))!;
    expect(reason).toContain("not answering");
    expect(reason).toContain("The operation timed out.");
    expect(reason).toContain("hangs instead of failing");
  });

  test("a server that keeps dying is a fault even while it answers", () => {
    expect(unwell(live({ restarts: 2 }))).toBeUndefined();
    const reason = unwell(live({ restarts: 4, upMs: 6 * 60_000 }))!;
    expect(reason).toContain("4 times");
    expect(reason).toContain("6 min ago");
  });

  test("answering, steady: nothing to say", () => {
    expect(unwell(live())).toBeUndefined();
  });
});
