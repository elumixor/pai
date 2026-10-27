import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "pai-dev-tasks-"));
process.env.PAI_DB = join(scratch, "pai.db");
process.env.PAI_CONFIG = join(scratch, "config.json");

const { brief, findValue, sessionProperty, statusOption, PROJECT_PREFIX, SESSION_PREFIX } = await import("./dev-tasks.ts");

const schema = [
  { id: "status", name: "Status", type: "select", options: [{ id: "o1", name: "Todo" }, { id: "o2", name: "In Progress" }, { id: "o3", name: "in review" }] },
  { id: "proj", name: "Dev project", type: "extension", extension: "ext-dev", extType: "project" },
  { id: "other", name: "Other session", type: "extension", extension: "ext-other", extType: "session" },
  { id: "sess", name: "Dev session", type: "extension", extension: "ext-dev", extType: "session" },
];

describe("dev tasks", () => {
  it("finds a project value whether own, inherited or wrapped", () => {
    expect(findValue({ proj: { urn: "dev:project/keep", label: "keep" } }, PROJECT_PREFIX)).toMatchObject({ key: "proj", urn: "dev:project/keep" });
    expect(findValue({ proj: { value: { urn: "dev:project/keep" }, inheritedFrom: "p1" } }, PROJECT_PREFIX)?.urn).toBe("dev:project/keep");
    expect(findValue({ sess: [{ urn: "dev:session/abc" }] }, SESSION_PREFIX)?.key).toBe("sess");
    expect(findValue({ title: "x", status: "o1" }, PROJECT_PREFIX)).toBeUndefined();
    expect(findValue(undefined, PROJECT_PREFIX)).toBeUndefined();
  });

  it("writes the session next to the project's extension", () => {
    expect(sessionProperty(schema, "proj")?.id).toBe("sess");
    expect(sessionProperty(schema.slice(0, 2), "proj")).toBeUndefined();
  });

  it("matches status options by name, ignoring case, and only when they exist", () => {
    expect(statusOption(schema, "doing")).toEqual({ property: "status", option: "o2" });
    expect(statusOption(schema, "review")).toEqual({ property: "status", option: "o3" });
    expect(statusOption([schema[0]!].map((p) => ({ ...p, options: p.options?.slice(0, 1) })), "doing")).toBeUndefined();
  });

  it("briefs with the title, the body and the titles above", () => {
    const text = brief({ id: "t1", title: "Fix login", body: "It loops.", path: ["Atma", "Keep"] }, "keep:page/t1");
    expect(text).toStartWith("# Fix login");
    expect(text).toContain("It loops.");
    expect(text).toContain("Atma › Keep › Fix login");
    expect(text).toContain("keep:page/t1");
  });
});
