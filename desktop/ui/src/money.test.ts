import { describe, expect, test } from "bun:test";
// The fill walks a rendered DOM; the parser itself is pure, and that is what is pinned here.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
const { amountsIn } = await import("./money.ts");

const one = (text: string) => amountsIn(text, "CZK")[0];
const all = (text: string) => amountsIn(text, "CZK");

describe("what the agents actually write", () => {
  test("a symbol, a multiplier and a period: $10–14k/mo", () => {
    expect(one("$10–14k/mo")).toMatchObject({ from: 10_000, to: 14_000, currency: "USD", assumed: false, per: "/mo" });
  });

  test("a range in thousands: $400–580k", () => {
    expect(one("around $400–580k for the year")).toMatchObject({ from: 400_000, to: 580_000, currency: "USD" });
  });

  test("a range with the multiplier only at the end: 172–210K", () => {
    expect(one("172–210K")).toMatchObject({ from: 172_000, to: 210_000, currency: "CZK", assumed: true });
  });

  test("an approximation: ~257K", () => expect(one("~257K")).toMatchObject({ from: 257_000, assumed: true }));

  test("thousands separators alone are enough: 112,400", () => {
    expect(one("112,400 in the account")).toMatchObject({ from: 112_400, currency: "CZK", assumed: true });
  });

  test("a trailing code: 265K CZK/mo", () => {
    expect(one("265K CZK/mo")).toMatchObject({ from: 265_000, currency: "CZK", assumed: false, per: "/mo" });
  });

  test("a symbol with separators: €9,000/mo", () => {
    expect(one("€9,000/mo")).toMatchObject({ from: 9000, currency: "EUR", per: "/mo" });
  });

  test("millions a year: 3.74M CZK/yr", () => {
    expect(one("3.74M CZK/yr")).toMatchObject({ from: 3_740_000, currency: "CZK", per: "/yr" });
  });

  test("a range per month: 103–162K/mo", () => {
    expect(one("103–162K/mo")).toMatchObject({ from: 103_000, to: 162_000, per: "/mo" });
  });
});

describe("what must never be money", () => {
  // `4k` is a screen and `v0.6.40` is a version: without a currency, a multiplier needs three
  // digits, a range or a period to count — a size must never be converted into money.
  test.each(["v0.6.40", "#87", "50.08216", "task 23", "2026-10-19", "17:10 UTC", "up 42 min", "90%", "a 4k monitor is 3840 wide", "an 8K display"])("%s", (text) => {
    expect(all(text)).toEqual([]);
  });

  test("but a small amount with a currency or a period still counts", () => {
    expect(one("$4k/mo")).toMatchObject({ from: 4000, currency: "USD", per: "/mo" });
    expect(one("10k/mo")).toMatchObject({ from: 10_000, assumed: true, per: "/mo" });
  });

  test("a percentage keeps its number out of it", () => expect(all("rates rose 12.5% this year")).toEqual([]));
});

describe("several in one line", () => {
  test("each is found where it sits", () => {
    const found = all("Offer: €9,000/mo base, $120k equity, 265K CZK bonus");
    expect(found.map((a) => a.currency)).toEqual(["EUR", "USD", "CZK"]);
    expect(found.map((a) => a.from)).toEqual([9000, 120_000, 265_000]);
  });
});
