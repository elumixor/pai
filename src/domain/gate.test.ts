import { afterEach, describe, expect, it } from "bun:test";
import * as gate from "./gate.ts";

const nothing = (p: number) => ({ nothing: p, act: 1 - p, user: 0 });

describe("gate", () => {
  const turns: string[] = [];
  const notes: string[] = [];
  const sinks = { turn: (t: string) => turns.push(t), note: (t: string) => notes.push(t) };
  afterEach(() => {
    turns.length = 0;
    notes.length = 0;
    gate.turnTaken();
  });

  it("splits a batch into its reports and drops the trailing instruction", () => {
    const batch = "[Hiring] Posted.\n\n[pai dev] Released as v1.\nMore lines.\n\n[Handle this yourself: the next step…]";
    expect(gate.split(batch)).toEqual(["[Hiring] Posted.", "[pai dev] Released as v1.\nMore lines."]);
    expect(gate.split("plain text")).toEqual(["plain text"]);
  });

  it("defers only when every report is nothing to do, else turns", async () => {
    gate.setJudge(async (r) => r.map(() => nothing(0.94)));
    await gate.screen("[Hiring] Posted.", sinks);
    expect(turns).toEqual([]);
    expect(notes).toEqual(["[Hiring] Posted."]);
    expect(gate.pending()).toBe(1);
    gate.setJudge(async () => [nothing(0.94), nothing(0.3)]);
    await gate.screen("[Hiring] Posted.\n\n[pai dev] Cannot log in.", sinks);
    expect(turns.length).toBe(1);
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
    gate.setJudge(async (r) => r.map(() => nothing(1)));
    await gate.screen("a", sinks);
    gate.turnTaken();
    expect(gate.pending()).toBe(0);
  });

  it("knows the boilerplate", () => {
    for (const t of ["No response needed.", "*(no response needed)*", "No action needed", "Nothing to do.", "Done."]) expect(gate.boilerplate(t)).toBe(true);
    for (const t of ["No response needed — pai dev is parked, nothing waiting on it.", "Journal and memory written for the rotation — no action needed from you.", "Posted."]) expect(gate.boilerplate(t)).toBe(false);
  });
});
