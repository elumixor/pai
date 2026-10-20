import { describe, expect, test } from "bun:test";
import { hitsIn, ring } from "./find.ts";

describe("where the scan looks first", () => {
  test("outward from the row he is on", () => {
    expect(ring(7, 3)).toEqual([3, 4, 2, 5, 1, 6, 0]);
  });

  test("from the top when nothing is anchored", () => {
    expect(ring(4, 0)).toEqual([0, 1, 2, 3]);
  });

  test("every row exactly once, wherever it starts", () => {
    for (const anchor of [-5, 0, 2, 9, 40]) expect([...ring(10, anchor)].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test("nothing to search is no order at all", () => expect(ring(0, 0)).toEqual([]));
});

describe("where a needle sits", () => {
  test("every occurrence, case folded", () => {
    expect(hitsIn("Daniel wrote to daniel about Daniel", "daniel")).toEqual([0, 16, 29]);
  });

  test("overlapping is counted once per step", () => expect(hitsIn("aaaa", "aa")).toEqual([0, 2]));
  test("an empty needle matches nothing, rather than everything", () => expect(hitsIn("anything", "")).toEqual([]));
  test("no match is an empty list", () => expect(hitsIn("ahoj", "zzz")).toEqual([]));
});

// The bar itself needs a document; happy-dom stands in for the browser.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
const { findBar } = await import("./find.ts");

const tick = (n = 1) => new Promise((resolve) => setTimeout(resolve, n));

describe("the first result arrives before the whole thread is scanned", () => {
  const build = (rows: number) => {
    const log = document.createElement("div");
    document.body.append(log);
    const targets = Array.from({ length: rows }, (_, i) => {
      const node = document.createElement("div");
      node.textContent = `row ${i} says daniel`;
      log.append(node);
      return { key: `k${i}`, text: node.textContent, reveal: () => node };
    });
    const bar = findBar({ scope: log, targets: () => targets });
    document.body.append(bar.node);
    return { bar, log };
  };

  test("the count shows the near matches first and climbs to all of them", async () => {
    const { bar, log } = build(300);
    bar.open();
    const input = bar.node.querySelector("input")!;
    input.value = "daniel";
    input.dispatchEvent(new Event("input"));
    await tick();
    const first = bar.node.querySelector(".find-count")!.textContent ?? "";
    // The first chunk is 40 rows: the bar is already saying something, and not "300".
    expect(first).toMatch(/^1 of \d+$/);
    expect(Number(first.replace(/^1 of /, ""))).toBeLessThan(300);
    expect(log.querySelectorAll("mark.find-hit").length).toBeGreaterThan(0);
    for (let i = 0; i < 20; i += 1) await tick();
    expect(bar.node.querySelector(".find-count")!.textContent).toBe("1 of 300");
    bar.close();
    expect(log.querySelectorAll("mark.find-hit").length).toBe(0);
  });

  test("the next keystroke abandons the scan in flight", async () => {
    const { bar } = build(300);
    bar.open();
    const input = bar.node.querySelector("input")!;
    input.value = "daniel";
    input.dispatchEvent(new Event("input"));
    await tick();
    input.value = "nothing here";
    input.dispatchEvent(new Event("input"));
    for (let i = 0; i < 20; i += 1) await tick();
    // The old scan cannot have gone on counting its own matches into this one.
    expect(bar.node.querySelector(".find-count")!.textContent).toBe("no matches");
  });

  test("escape puts the text back exactly as it was", async () => {
    const { bar, log } = build(3);
    const before = log.innerHTML;
    bar.open();
    const input = bar.node.querySelector("input")!;
    input.value = "says";
    input.dispatchEvent(new Event("input"));
    for (let i = 0; i < 5; i += 1) await tick();
    expect(log.innerHTML).not.toBe(before);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(log.innerHTML).toBe(before);
  });
});
