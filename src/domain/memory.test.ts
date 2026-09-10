import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PAI_WORKSPACE = mkdtempSync(join(tmpdir(), "pai-memory-"));

const { MemoryNameError, all, forget, get, index, recall, remember } = await import("./memory.ts");

const fact = {
  name: "hetzner-box",
  type: "project" as const,
  description: "The daemon runs on a Hetzner CX43 reached over Tailscale",
  body: "Port 22 is closed; `tailscale ssh` is the way in.",
};

afterEach(() => {
  for (const memory of all()) forget(memory.name);
});

describe("memory", () => {
  it("round-trips a saved fact", () => {
    remember(fact);
    expect(get("hetzner-box")).toMatchObject({ ...fact, updatedAt: new Date().toISOString().slice(0, 10) });
  });

  it("slugifies a name into a filename", () => {
    remember({ ...fact, name: "Hetzner Box!" });
    expect(get("hetzner-box")).toBeDefined();
  });

  it("rejects a name that slugifies to nothing", () => {
    expect(() => remember({ ...fact, name: "!!!" })).toThrow(MemoryNameError);
  });

  it("replaces rather than duplicates", () => {
    remember(fact);
    remember({ ...fact, body: "Second version" });
    expect(all()).toHaveLength(1);
    expect(get("hetzner-box")?.body).toBe("Second version");
  });

  it("collapses whitespace in the description", () => {
    remember({ ...fact, description: "one   two\nthree" });
    expect(get("hetzner-box")?.description).toBe("one two three");
  });

  it("forgets, and says whether there was anything to forget", () => {
    remember(fact);
    expect(forget("hetzner-box")).toBe(true);
    expect(forget("hetzner-box")).toBe(false);
    expect(get("hetzner-box")).toBeUndefined();
  });

  it("ranks a description match above a body-only match", () => {
    remember(fact);
    remember({ ...fact, name: "ssh-notes", description: "Notes about shells", body: "Tailscale is mentioned here." });
    expect(recall("tailscale").map((m) => m.name)).toEqual(["hetzner-box", "ssh-notes"]);
  });

  it("returns everything for an empty query", () => {
    remember(fact);
    expect(recall("")).toHaveLength(1);
  });

  it("returns nothing when no memory mentions the words", () => {
    remember(fact);
    expect(recall("kubernetes")).toHaveLength(0);
  });

  it("indexes one line per memory, and says so when empty", () => {
    expect(index()).toBe("(nothing saved yet)");
    remember(fact);
    expect(index()).toBe(`- hetzner-box (project): ${fact.description}`);
  });
});
