import { afterEach, describe, expect, it } from "bun:test";
import * as gate from "./gate.ts";

describe("gate", () => {
  const turns: string[] = [];
  const notes: string[] = [];
  const sinks = { turn: (t: string) => turns.push(t), note: (t: string) => notes.push(t) };
  afterEach(() => {
    turns.length = 0;
    notes.length = 0;
    gate.turnTaken();
  });

  it("turns when the odds reach the threshold, notes below it", async () => {
    gate.setJudge(async () => ({ act: false, odds: 0.1, reason: "done" }));
    await gate.screen("[Hiring] Posted.", sinks);
    expect(turns).toEqual([]);
    expect(notes).toEqual(["[Hiring] Posted."]);
    expect(gate.pending()).toBe(1);
    gate.setJudge(async () => ({ act: true, odds: 0.6, reason: "blocked" }));
    await gate.screen("[Hiring] Cannot log in.", sinks);
    expect(turns).toEqual(["[Hiring] Cannot log in."]);
  });

  it("fails open", async () => {
    gate.setJudge(async () => {
      throw new Error("down");
    });
    const v = await gate.screen("x", sinks);
    expect(v.act).toBe(true);
    expect(turns).toEqual(["x"]);
  });

  it("a turn clears what was deferred", async () => {
    gate.setJudge(async () => ({ act: false, odds: 0, reason: "" }));
    await gate.screen("a", sinks);
    gate.turnTaken();
    expect(gate.pending()).toBe(0);
  });

  it("knows the boilerplate", () => {
    for (const t of ["No response needed.", "*(no response needed)*", "No action needed", "Nothing to do.", "Done."]) expect(gate.boilerplate(t)).toBe(true);
    for (const t of ["No response needed — pai dev is parked, nothing waiting on it.", "Journal and memory written for the rotation — no action needed from you.", "Posted."]) expect(gate.boilerplate(t)).toBe(false);
  });
});
