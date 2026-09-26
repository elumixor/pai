import { describe, expect, test } from "bun:test";
import { modules } from "../modules/index.ts";
import { instructionsFor, moduleHeading, moduleSections } from "./prompts.ts";

describe("instructions", () => {
  test("general part first, then one headed section per module", () => {
    const text = instructionsFor("chat");
    expect(text.startsWith("\nYou are pai")).toBe(true);
    const sections = moduleSections("chat");
    for (const m of modules.filter((m) => m.enabled() && m.prompt?.kinds.includes("chat"))) {
      expect(sections.some((s) => s.module === m.name)).toBe(true);
      expect(text).toContain(`${moduleHeading(m.title)}\n${m.prompt!.text}`);
    }
    // Every section sits after the general instructions, in the order the modules are listed.
    let last = -1;
    for (const s of sections) {
      const at = text.indexOf(s.section);
      expect(at).toBeGreaterThan(text.indexOf("You are one conversation"));
      expect(at).toBeGreaterThan(last);
      last = at;
    }
  });

  test("a coding session gets only what is meant for it", () => {
    const text = instructionsFor("code");
    expect(text).toContain("You are a coding session");
    for (const m of modules.filter((m) => m.enabled() && m.prompt && !m.prompt.kinds.includes("code"))) expect(text).not.toContain(moduleHeading(m.title));
  });
});
