import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Rows are written, and configuration is frozen at import: a scratch database first.
process.env.PAI_DB = join(mkdtempSync(join(tmpdir(), "pai-audit-")), "pai.db");

const audit = await import("./audit.ts");

describe("what counts as outward", () => {
  test("sends, writes and clicks in signed-in sites", () => {
    for (const name of [
      "mcp__gmail__gmail_send",
      "mcp__linkedin__linkedin_reply",
      "mcp__telegram__send_message",
      "mcp__claude_ai_Balance__create_event",
      "mcp__claude_ai_Balance__set_notes",
      "mcp__claude_ai_Notion__notion-create-pages",
      "mcp__claude_ai_Claude_Docs__update",
      "mcp__playwright__browser_click",
      "mcp__atma__set_hours",
      "Artifact",
    ])
      expect(audit.outward(name)).toBe(true);
  });

  test("reads, the daemon's own bookkeeping and built-ins stay out", () => {
    for (const name of [
      "mcp__gmail__gmail_search",
      "mcp__linkedin__linkedin_thread",
      "mcp__claude_ai_Balance__list_events",
      "mcp__claude_ai_Google_Drive__download_file_content",
      "mcp__playwright__browser_navigate",
      "mcp__playwright__browser_evaluate",
      "mcp__pai__task_update",
      "mcp__pai__remember",
      "mcp__builder__send_to_thread",
      "Bash",
      "Write",
      "WebFetch",
    ])
      expect(audit.outward(name)).toBe(false);
  });
});

describe("the trail", () => {
  test("an outward call is kept with its input and settled by its result; others are not kept", () => {
    const base = { sessionId: "s1", agent: "outreach", summary: "linkedin:linkedin_reply Hi Anna" };
    audit.record({ ...base, toolUseId: "t1", tool: "mcp__linkedin__linkedin_reply", input: { thread: "anna", text: "Hi Anna" } });
    audit.record({ ...base, toolUseId: "t2", tool: "mcp__linkedin__linkedin_thread", input: { thread: "anna" } });
    expect(audit.list().map((e) => e.toolUseId)).toEqual(["t1"]);
    expect(audit.list()[0]!.ok).toBeNull();

    audit.settle("t1", "sent", false);
    audit.settle("t2", "a thread", false);
    const [entry] = audit.list();
    expect(entry!.ok).toBe(true);
    expect(entry!.result).toBe("sent");
    expect(JSON.parse(entry!.input).text).toBe("Hi Anna");
  });

  test("filters by agent and by words in the input", () => {
    audit.record({ toolUseId: "t3", sessionId: "s2", agent: "mail", tool: "mcp__gmail__gmail_send", summary: "gmail:gmail_send work", input: { to: "bob@example.com" } });
    audit.settle("t3", "Error: 403", true);
    expect(audit.list({ agent: "mail" }).map((e) => e.toolUseId)).toEqual(["t3"]);
    expect(audit.list({ search: "bob@" })[0]!.ok).toBe(false);
    expect(audit.list({ search: "nobody" })).toEqual([]);
  });
});
