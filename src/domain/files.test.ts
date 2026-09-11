import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const devRoot = mkdtempSync(join(tmpdir(), "pai-files-"));
process.env.PAI_DEV_ROOT = devRoot;
process.env.PAI_WORKSPACE = mkdtempSync(join(tmpdir(), "pai-ws-"));

const { FileAccessError, documents, list, read, roots } = await import("./files.ts");

mkdirSync(join(devRoot, "project", "src"), { recursive: true });
mkdirSync(join(devRoot, "project", "node_modules"), { recursive: true });
writeFileSync(join(devRoot, "project", "README.md"), "# Project\n");
writeFileSync(join(devRoot, "project", "src", "main.ts"), "export const answer = 42;\n");

describe("files", () => {
  it("lists a directory, folders first", () => {
    const entries = list(join(devRoot, "project"));
    expect(entries.map((e) => e.name)).toEqual(["src", "README.md"]);
    expect(entries[0]?.directory).toBe(true);
  });

  it("hides node_modules and .git", () => {
    expect(list(join(devRoot, "project")).map((e) => e.name)).not.toContain("node_modules");
  });

  it("reads a file", async () => {
    const file = await read(join(devRoot, "project", "src", "main.ts"));
    expect(file.text).toContain("answer = 42");
    expect(file.truncated).toBe(false);
  });

  it("refuses a path outside the roots it serves", () => {
    expect(() => list("/etc")).toThrow(FileAccessError);
    expect(read("/etc/passwd")).rejects.toThrow(FileAccessError);
  });

  it("refuses to climb out with ..", () => {
    expect(() => list(join(devRoot, "..", "..", "etc"))).toThrow(FileAccessError);
  });

  it("refuses a directory when asked for a file", () => {
    expect(read(join(devRoot, "project"))).rejects.toThrow(FileAccessError);
  });

  it("names the roots it will serve", () => {
    expect(roots().map((r) => r.name)).toEqual(["projects", "workspace", "pai"]);
  });

  it("lists the documents worth reading", () => {
    expect(documents().some((doc) => doc.name.endsWith("README.md"))).toBe(true);
  });
});
