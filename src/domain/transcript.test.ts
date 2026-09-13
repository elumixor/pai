import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.PAI_CLAUDE_PROJECTS = mkdtempSync(join(tmpdir(), "pai-claude-projects-"));
const { transcript } = await import("./transcript.ts");

/** A transcript as Claude Code writes it: one JSON object per line, tool calls inline. */
function write(lines: unknown[]) {
  const root = mkdtempSync(join(tmpdir(), "pai-transcript-"));
  const cwd = join(root, "project");
  mkdirSync(cwd, { recursive: true });
  const projects = process.env.PAI_CLAUDE_PROJECTS!;
  const dir = join(projects, cwd.replace(/[/.]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const id = `test-${Math.random().toString(36).slice(2)}`;
  writeFileSync(join(dir, `${id}.jsonl`), lines.map((line) => JSON.stringify(line)).join("\n"));
  return { id, cwd };
}

describe("transcript", () => {
  it("reads the conversation in order", async () => {
    const { id, cwd } = write([
      { type: "mode", mode: "normal" },
      { type: "user", timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "hello" } },
      {
        type: "assistant",
        timestamp: "2026-01-01T00:00:01Z",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      },
    ]);
    const messages = await transcript(id, cwd);
    expect(messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "hello"],
      ["assistant", "hi"],
    ]);
  });

  it("keeps tool calls and drops tool results", async () => {
    const { id, cwd } = write([
      {
        type: "assistant",
        timestamp: "2026-01-01T00:00:02Z",
        message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "ls -la" } }] },
      },
      { type: "user", timestamp: "2026-01-01T00:00:03Z", message: { role: "user", content: [{ type: "tool_result", content: "out" }] } },
    ]);
    const messages = await transcript(id, cwd);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.tools).toEqual([{ name: "Bash", input: "ls -la" }]);
  });

  it("marks injected context as meta and skips sidechains", async () => {
    const { id, cwd } = write([
      { type: "user", timestamp: "2026-01-01T00:00:04Z", message: { role: "user", content: "<system-reminder>x</system-reminder>" } },
      { type: "assistant", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "sub" }] } },
    ]);
    const messages = await transcript(id, cwd);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.meta).toBe(true);
  });

  it("is empty for a session with no transcript", async () => {
    expect(await transcript("00000000-0000-0000-0000-000000000000")).toEqual([]);
  });

  it("keeps only the last `limit` messages", async () => {
    const lines = Array.from({ length: 10 }, (_, index) => ({
      type: "user",
      timestamp: "2026-01-01T00:00:05Z",
      message: { role: "user", content: `m${index}` },
    }));
    const { id, cwd } = write(lines);
    const messages = await transcript(id, cwd, 3);
    expect(messages.map((m) => m.text)).toEqual(["m7", "m8", "m9"]);
  });
});
