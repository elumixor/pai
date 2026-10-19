import { describe, expect, test } from "bun:test";
import { isLimit, limitLine, MARGIN_MS, resetAt } from "./limits.ts";

const AT = Date.parse("2026-10-19T17:07:30Z");

describe("the account's limit, as it arrives", () => {
  test("the real sentence is recognised", () => {
    expect(isLimit("You've hit your session limit · resets 5:10pm (UTC)")).toBe(true);
    expect(isLimit("you have reached your weekly limit")).toBe(true);
    expect(isLimit("Usage limit reached")).toBe(true);
  });

  test("an answer that merely talks about limits is not one", () => {
    expect(isLimit("I set the budget limit to 40 turns a day.")).toBe(false);
    expect(isLimit("Your turn died on the account's session limit, not on a refusal.")).toBe(false);
  });

  test("the reset time is read as UTC wall clock, with a margin", () => {
    expect(resetAt("You've hit your session limit · resets 5:10pm (UTC)", AT)).toBe(Date.parse("2026-10-19T17:10:00Z") + MARGIN_MS);
    expect(resetAt("resets at 17:10", AT)).toBe(Date.parse("2026-10-19T17:10:00Z") + MARGIN_MS);
  });

  test("a time already past means the next one, not one in the past", () => {
    expect(resetAt("resets 9:00am (UTC)", AT)).toBe(Date.parse("2026-10-20T09:00:00Z") + MARGIN_MS);
  });

  test("no time in the text still gives a time to try again", () => {
    expect(resetAt("You've hit your session limit", AT)).toBeGreaterThan(AT);
  });

  test("the line says who stopped and when the work goes on", () => {
    expect(limitLine("Job search", Date.parse("2026-10-19T17:11:00Z"))).toBe("Job search paused on the account's limit — picking it up again at 17:11 UTC");
  });
});
