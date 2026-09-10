import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const devRoot = mkdtempSync(join(tmpdir(), "pai-dev-"));
process.env.PAI_DEV_ROOT = devRoot;
process.env.PAI_DB = join(mkdtempSync(join(tmpdir(), "pai-db-")), "pai.db");

const { catalogText, get, refresh, scan } = await import("./catalog.ts");

function repo(relative: string, readme?: string) {
  const path = join(devRoot, relative);
  mkdirSync(join(path, ".git"), { recursive: true });
  if (readme) writeFileSync(join(path, "README.md"), readme);
  return path;
}

repo("solo", "# Solo\n\n[![badge](x)](y)\n\nA standalone tool that does one thing.\n");
repo("atma/hypocrisy", "# Hypocrisy\n\nA game about telling the truth.\n");
mkdirSync(join(devRoot, "notes"), { recursive: true });
mkdirSync(join(devRoot, "solo", "node_modules", "pkg"), { recursive: true });

describe("catalog", () => {
  it("finds a repository at the root", () => {
    expect(scan().map((p) => p.slug)).toContain("solo");
  });

  it("finds a repository one level down", () => {
    expect(scan().map((p) => p.slug)).toContain("hypocrisy");
  });

  it("ignores directories that are not repositories", () => {
    expect(scan().map((p) => p.slug)).not.toContain("notes");
  });

  it("does not descend into a repository it already found", () => {
    expect(scan().map((p) => p.slug)).not.toContain("pkg");
  });

  it("summarises from the first line of prose in the readme", () => {
    const solo = scan().find((p) => p.slug === "solo");
    expect(solo?.summary).toContain("A standalone tool that does one thing.");
  });

  it("persists the scan so lookups work without rescanning", () => {
    refresh();
    expect(get("hypocrisy")?.path).toBe(join(devRoot, "atma", "hypocrisy"));
  });

  it("renders one line per project", () => {
    refresh();
    expect(catalogText()).toContain("hypocrisy");
    expect(catalogText().split("\n").length).toBeGreaterThanOrEqual(2);
  });
});
