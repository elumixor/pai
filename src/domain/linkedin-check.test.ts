import { describe, expect, test } from "bun:test";
import { unwell, type Signal } from "./linkedin-check.ts";

const now = 1_791_800_000_000;
const h = 3_600_000;
// Measured from his own history: 5178 linkedin.message events in three weeks, the worst completed
// quiet stretch 56.6h, and the silence that prompted this check 83h.
const normalGap = 56.6 * h;

const live = (over: Partial<Signal> = {}): Signal => ({
  answering: true,
  signedIn: true,
  lastPollAt: now - 4 * 60_000,
  pollOk: true,
  pollEveryMs: 5 * 60_000,
  upMs: 6 * h,
  lastMessageAt: now - 2 * h,
  longestGapMs: normalGap,
  ...over,
});

describe("LinkedIn, the bad edge", () => {
  test("a module that does not answer its own status route", () => {
    const reason = unwell(live({ answering: false }), now)!;
    expect(reason).toContain("did not answer its own status route within 45s");
    // The sentence may not claim it never started: a wedged page looks identical from here.
    expect(reason).toContain("look the same");
  });

  test("signed out, with how long since the last read", () => {
    const reason = unwell(live({ signedIn: false, lastPollAt: now - 9 * h }), now)!;
    expect(reason).toContain("signed out");
    expect(reason).toContain("9h ago");
    expect(reason).toContain("pai browser login linkedin");
  });

  test("a read that failed carries its error", () => {
    expect(unwell(live({ pollOk: false, pollError: "999 from Voyager" }), now)).toContain("999 from Voyager");
  });

  test("a poller that stopped running, measured against its own interval", () => {
    expect(unwell(live({ lastPollAt: now - 2 * h }), now)).toContain("has not been read for 120 min");
    // Within three intervals is not late, and never late sooner than half an hour.
    expect(unwell(live({ lastPollAt: now - 12 * 60_000 }), now)).toBeUndefined();
  });

  test("never read at all — but not while the daemon is still starting", () => {
    expect(unwell(live({ lastPollAt: undefined, pollOk: undefined, upMs: 2 * h }), now)).toContain("not been read once");
    expect(unwell(live({ lastPollAt: undefined, pollOk: undefined, upMs: 5 * 60_000 }), now)).toBeUndefined();
  });
});

describe("LinkedIn, the silent edge", () => {
  test("silence worse than his own quietest stretch says so, with both ages", () => {
    const reason = unwell(live({ lastMessageAt: now - 83 * h }), now)!;
    expect(reason).toContain("nothing has arrived in 83h");
    expect(reason).toContain("the month before that was 57h");
  });

  test("a quiet stretch he has had before is not a fault", () => {
    expect(unwell(live({ lastMessageAt: now - 50 * h }), now)).toBeUndefined();
  });

  test("with no traffic history, the floor is what speaks", () => {
    expect(unwell(live({ lastMessageAt: now - 20 * h, longestGapMs: undefined }), now)).toBeUndefined();
    expect(unwell(live({ lastMessageAt: now - 40 * h, longestGapMs: undefined }), now)).toContain("nothing has arrived in 40h");
  });

  test("a mailbox that never had an event is not claimed to be silent", () => {
    expect(unwell(live({ lastMessageAt: undefined }), now)).toBeUndefined();
  });
});

describe("LinkedIn, healthy", () => {
  test("reading and hearing: nothing to say", () => {
    expect(unwell(live(), now)).toBeUndefined();
  });

  test("signed-in state it could not read does not mute the silence check", () => {
    expect(unwell(live({ signedIn: undefined, lastMessageAt: now - 83 * h }), now)).toContain("83h");
  });
});

