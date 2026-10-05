import { describe, expect, it } from "bun:test";

process.env.PAI_TIMEZONE = "Europe/Prague";
process.env.PAI_QUIET_HOURS = "23:00-08:00";
const { cronMatches, nextFire, parseCron, quiet, quietEnds, within, zoned, day } = await import("./time.ts");

// 2026-10-05 is a Monday; Prague is UTC+2 in October.
const at = (iso: string) => Date.parse(iso);

describe("time", () => {
  it("reads the wall clock in the user's zone", () => {
    const z = zoned(at("2026-10-05T06:30:00Z"));
    expect([z.hour, z.minute, z.weekday]).toEqual([8, 30, 1]);
    expect(day(at("2026-10-05T22:30:00Z"))).toBe("2026-10-06");
  });

  it("matches cron in that zone", () => {
    expect(cronMatches("30 8 * * *", at("2026-10-05T06:30:00Z"))).toBe(true);
    expect(cronMatches("30 8 * * *", at("2026-10-05T08:30:00Z"))).toBe(false);
    expect(cronMatches("0 9 * * 1", at("2026-10-05T07:00:00Z"))).toBe(true);
    expect(cronMatches("0 9 * * 1", at("2026-10-06T07:00:00Z"))).toBe(false);
    expect(cronMatches("*/15 * * * *", at("2026-10-05T07:45:00Z"))).toBe(true);
    expect(cronMatches("*/15 * * * *", at("2026-10-05T07:44:00Z"))).toBe(false);
    expect(cronMatches("0 0 * * 7", at("2026-10-03T22:00:00Z"))).toBe(true); // Sunday 00:00 local
  });

  it("refuses a malformed schedule", () => {
    expect(() => parseCron("every morning")).toThrow();
    expect(() => parseCron("61 * * * *")).toThrow();
  });

  it("finds the next firing", () => {
    expect(new Date(nextFire("30 8 * * *", at("2026-10-05T07:00:00Z"))!).toISOString()).toBe("2026-10-06T06:30:00.000Z");
  });

  it("knows quiet hours across midnight", () => {
    expect(within("23:00-08:00", at("2026-10-05T22:30:00Z"))).toBe(true); // 00:30 local
    expect(within("23:00-08:00", at("2026-10-05T07:00:00Z"))).toBe(false); // 09:00 local
    expect(within("12:00-13:00", at("2026-10-05T10:30:00Z"))).toBe(true);
    expect(quiet(at("2026-10-05T21:30:00Z"))).toBe(true); // 23:30 local
    expect(new Date(quietEnds(at("2026-10-05T21:30:00Z"))).toISOString()).toBe("2026-10-06T06:00:00.000Z");
  });
});
