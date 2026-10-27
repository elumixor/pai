import { describe, expect, test } from "bun:test";
import { GRACE_MS, overdue, type Lag } from "./release-check.ts";

const now = 1_791_750_000_000;
const lag = (over: Partial<Lag> = {}): Lag => ({ target: "v0.6.24", behind: 2, dirty: false, head: "d11bd62", ...over });

describe("a release that did not arrive", () => {
  test("silent while the daemon is caught up, or has nothing to follow", () => {
    expect(overdue(lag({ behind: 0 }), now - GRACE_MS * 2, now)).toBeUndefined();
    expect(overdue(lag({ target: undefined }), now - GRACE_MS * 2, now)).toBeUndefined();
  });

  test("silent inside the window CI needs — a release in flight is not a failure", () => {
    // The real pattern: eight consecutive releases landed 5–7 minutes after their tag.
    expect(overdue(lag(), now - 6 * 60_000, now)).toBeUndefined();
    expect(overdue(lag(), now - GRACE_MS + 1, now)).toBeUndefined();
  });

  test("silent on a checkout someone is working in", () => {
    expect(overdue(lag({ dirty: true }), now - GRACE_MS * 3, now)).toBeUndefined();
  });

  test("silent when git cannot date the tag, rather than guessing", () => {
    expect(overdue(lag(), undefined, now)).toBeUndefined();
  });

  test("past the window it names the tag, the age, and what the daemon is on", () => {
    const reason = overdue(lag(), now - 38 * 60_000, now)!;
    expect(reason).toContain("v0.6.24");
    expect(reason).toContain("38 minutes ago");
    expect(reason).toContain("still on d11bd62");
    expect(reason).toContain("2 commits behind");
  });

  test("one commit behind reads as one commit", () => {
    expect(overdue(lag({ behind: 1 }), now - 60 * 60_000, now)).toContain("1 commit behind");
  });
});
