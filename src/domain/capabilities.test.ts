import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Configuration is read once, at import: a scratch database first, so noteInit writes next to it.
const scratch = mkdtempSync(join(tmpdir(), "pai-caps-"));
process.env.PAI_DB = join(scratch, "pai.db");
process.env.PAI_DENY_CONNECTORS = "claude.ai Google Calendar";

const { noteInit } = await import("./context.ts");
const { narrowed, serverAllowed, unresolved } = await import("./capabilities.ts");

const SERVERS = ["pai", "playwright", "gmail", "telegram", "linkedin", "claude.ai Balance", "claude.ai Notion", "claude.ai Google Calendar"];

describe("capabilities", () => {
  test("a capability matches the server whose name contains it", () => {
    expect(serverAllowed("gmail", ["gmail", "notion"])).toBe(true);
    expect(serverAllowed("claude.ai Notion", ["gmail", "notion"])).toBe(true);
    expect(serverAllowed("linkedin", ["gmail", "notion"])).toBe(false);
  });

  test("pai is always in, and no list at all means every server", () => {
    expect(serverAllowed("pai", ["gmail"])).toBe(true);
    expect(serverAllowed("linkedin", undefined)).toBe(true);
    expect(serverAllowed("linkedin", ["*"])).toBe(true);
  });

  test("browser is the playwright server and calendar is Balance", () => {
    expect(serverAllowed("playwright", ["browser"])).toBe(true);
    expect(serverAllowed("claude.ai Balance", ["calendar"])).toBe(true);
    // An alias adds a name, it does not loosen the match: nothing else comes with it.
    expect(serverAllowed("claude.ai Notion", ["browser"])).toBe(false);
    expect(serverAllowed("gmail", ["calendar"])).toBe(false);
  });

  test("a sub-agent keeps the capabilities its parent covers, aliases included", () => {
    expect(narrowed(["gmail", "linkedin"], ["gmail"])).toEqual(["gmail"]);
    expect(narrowed(["browser"], ["playwright"])).toEqual(["browser"]);
    expect(narrowed(["playwright"], ["browser"])).toEqual(["playwright"]);
    expect(narrowed(["browser", "gmail"], ["*"])).toEqual(["browser", "gmail"]);
  });

  test("a capability no server provides is reported, an aliased one is not", () => {
    noteInit("chat", { tools: [], mcpServers: SERVERS.map((name) => ({ name, status: "connected" })), skills: [], slashCommands: [], agents: [], model: "test", at: new Date().toISOString() });
    expect(unresolved(["browser", "calendar", "gmail", "linkedin"])).toEqual([]);
    expect(unresolved(["slack", "sheets"])).toEqual(["slack", "sheets"]);
    // The Google calendar is denied to every session, so a capability only it would answer is not one.
    expect(unresolved(["google calendar"])).toEqual(["google calendar"]);
    expect(unresolved(null)).toEqual([]);
    expect(unresolved(["*"])).toEqual([]);
  });
});
