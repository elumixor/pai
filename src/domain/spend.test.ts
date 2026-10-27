import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "pai-spend-"));
process.env.PAI_DB = join(dir, "pai.db");
process.env.PAI_CLAUDE_PLAN_USD = "200";
const { price, scan, report, recordGateway } = await import("./spend.ts");

const assistant = (id: string, output: number, entrypoint = "cli", model = "claude-opus-5-5") =>
  `${JSON.stringify({
    type: "assistant",
    entrypoint,
    sessionId: "s1",
    cwd: "/Users/someone/dev/pai",
    timestamp: new Date().toISOString(),
    message: { id, model, usage: { input_tokens: 1_000_000, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  })}\n`;

describe("spend", () => {
  test("prices by model, with cache writes by their lifetime", () => {
    expect(price("claude-opus-5-5", { input: 1e6, output: 1e6, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 })).toBeCloseTo(24);
    expect(price("claude-sonnet-5", { input: 0, output: 0, cacheRead: 1e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6 })).toBeCloseTo(0.2 + 2.5 + 4);
    expect(price("claude-opus-5-5", { input: 1e6, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, true)).toBeCloseTo(8);
  });

  test("a response written once per content block is counted once, and only new lines are read", () => {
    const projects = join(dir, "projects", "-dev-pai");
    mkdirSync(projects, { recursive: true });
    const file = join(projects, "s1.jsonl");
    appendFileSync(file, assistant("msg_a", 10) + assistant("msg_a", 1_000_000) + assistant("msg_b", 0, "sdk-ts"));
    expect(scan(join(dir, "projects"))).toBe(3);
    expect(scan(join(dir, "projects"))).toBe(0);
    appendFileSync(file, '{"type":"assistant","message":{"id":"msg_c"'); // half a line waits
    expect(scan(join(dir, "projects"))).toBe(0);
  });

  test("the plan's fee is shared by API price; metered calls are paid as they are", async () => {
    recordGateway("google/gemini-2.5-flash-lite", { cost: 0.5 }, 100, "summaries");
    const r = await report(30);
    // msg_a: $4 in + $20 out; msg_b: $4 in.
    expect(r.total.apiUsd).toBeCloseTo(28.5);
    const plan = (200 * 30) / 30.44;
    expect(r.total.realUsd).toBeCloseTo(plan + 0.5);
    const terminal = r.by.source.find((b) => b.key === "terminal")!;
    expect(terminal.realUsd).toBeCloseTo((plan * 24) / 28);
    expect(r.by.project.find((b) => b.key === "pai")?.calls).toBe(2);
  });
});
