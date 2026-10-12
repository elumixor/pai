import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "pai-repeats-"));
process.env.PAI_DATA = dir;
process.env.PAI_DB = join(dir, "pai.db");
process.env.AI_GATEWAY_API_KEY = "test";
import type * as Decide from "./decide.ts";
const decide = await import("./decide.ts");
const asks = await import("./asks.ts");
const tasks = await import("./tasks.ts");
const { repeatOf } = await import("./repeats.ts");

const choice = (c: string, p: number): Decide.ChoiceAnswer => ({ type: "choice", choice: c, confidence: p, probabilities: { [c]: p } });

describe("repeats", () => {
  const t = tasks.add({ title: "LFS quota at 100% — buy a data pack or prune", owner: "atma", status: "waiting_user" });
  const a = asks.ask({ agent: "pai", question: "Push Atma's 4 commits?", blocking: false, fallback: "wait" });

  it("names the waiting task or ask the model is sure the question repeats", async () => {
    decide.setAsk(async () => ({ same: choice(`t${t.id}`, 0.93) }));
    expect(await repeatOf("LFS storage is full. Fix it how?")).toMatchObject({ kind: "task", task: { id: t.id } });
    decide.setAsk(async () => ({ same: choice(`a${a.id}`, 0.9) }));
    expect(await repeatOf("Ship Atma's fixes?")).toMatchObject({ kind: "ask", ask: { id: a.id } });
  });

  it("lets the ask through on doubt, on none, on its own task and on an error", async () => {
    decide.setAsk(async () => ({ same: choice(`t${t.id}`, 0.5) }));
    expect(await repeatOf("LFS?")).toBeUndefined();
    decide.setAsk(async () => ({ same: choice("none", 0.99) }));
    expect(await repeatOf("Hire Anna?")).toBeUndefined();
    let offered: Record<string, unknown> = {};
    decide.setAsk(async (_, q) => ((offered = (q.same as Decide.Choice).criteria), { same: choice("none", 0.9) }));
    await repeatOf("LFS: prune?", t.id);
    expect(Object.keys(offered)).not.toContain(`t${t.id}`);
    decide.setAsk(async () => {
      throw new Error("502");
    });
    expect(await repeatOf("LFS?")).toBeUndefined();
  });
});
