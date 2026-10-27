import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Keep and dev are HTTP servers in this process; the daemon is pointed at them before anything from src loads.
const WS = "9137ed3f-e42b-4953-821c-ad86b1d6b9bc";
const SECRET = "hook-secret";
const scratch = mkdtempSync(join(tmpdir(), "pai-dev-tasks-e2e-"));
process.env.PAI_DB = join(scratch, "pai.db");
process.env.PAI_PORT = "8898";
process.env.PAI_BIND = "127.0.0.1";
process.env.PAI_NO_TELEGRAM = "1";
process.env.PAI_CONFIG = join(scratch, "config.json");
process.env.PAI_CLAUDE_PROJECTS = join(scratch, "claude-projects");
process.env.PAI_KEEP_WEBHOOK_SECRETS = SECRET;
process.env.PAI_KEEP_KEYS = `${WS}:keep_test`;

// A task's properties come from its trait: values are keyed by property name.
const taskSchema = [
  { name: "Status", type: "select", options: [{ id: "todo", name: "Todo" }, { id: "doing", name: "In progress" }, { id: "review", name: "In review" }] },
  { name: "Dev project", type: "extension", extension: "dev", extType: "project", inherit: true },
  { name: "Dev session", type: "extension", extension: "dev", extType: "session" },
];
const pages: Record<string, { id: string; title: string; schema: unknown[]; views?: unknown[]; inheritedFrom?: Record<string, string>; body: string; properties: Record<string, unknown>; effective: Record<string, unknown> }> = {
  task: { id: "task", title: "Fix login", body: "It loops after sign-in.", schema: taskSchema, properties: {}, effective: { "Dev project": { urn: "dev:project/scratch", label: "scratch", fields: { worktree: true }, inheritedFrom: "proj" } } },
  tasks: { id: "tasks", title: "Tasks", body: "", schema: [], views: [{ embedded: false }], properties: {}, effective: { "Dev project": { urn: "dev:project/scratch" } } },
  projpage: { id: "projpage", title: "Scratch", body: "", schema: [{ name: "Dev project", type: "extension", extension: "dev", extType: "project", inherit: true }], properties: { "Dev project": { urn: "dev:project/scratch" } }, effective: { "Dev project": { urn: "dev:project/scratch" } } },
  sub: { id: "sub", title: "Write docs", body: "The README.", schema: [], properties: {}, inheritedFrom: { "Dev project": "projpage" }, effective: { "Dev project": { urn: "dev:project/scratch", label: "scratch" } } },
  plain: { id: "plain", title: "Buy milk", body: "", schema: [], properties: {}, effective: {} },
};
const keepCalls: { tool: string; args: Record<string, unknown>; auth: string | null }[] = [];
const starts: Record<string, unknown>[] = [];
let busy = true;

const keep = Bun.serve({
  port: 0,
  async fetch(req) {
    const { id, params } = (await req.json()) as { id: number; params: { name: string; arguments: Record<string, unknown> } };
    keepCalls.push({ tool: params.name, args: params.arguments, auth: req.headers.get("authorization") });
    if (params.name === "list_extensions") {
      const value = [{ id: "dev", manifest: { propertyTypes: [{ id: "project" }, { id: "session" }] } }];
      return Response.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(value) }] } });
    }
    const page = pages[String(params.arguments.id)]!;
    if (params.name === "set_properties") {
      if (params.arguments.define) page.schema = [...page.schema, ...(params.arguments.define as unknown[])];
      Object.assign(page.properties, params.arguments.properties);
      Object.assign(page.effective, params.arguments.properties);
    }
    const value = params.name === "get_page" ? { ...page, urn: `keep:page/${page.id}`, path: ["Atma", "Scratch"] } : { id: page.id };
    return Response.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value } });
  },
});
const dev = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/mcp") {
      const { id, params } = (await req.json()) as { id: number; params: { arguments: Record<string, unknown> } };
      starts.push(params.arguments);
      return Response.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify({ session: "dev:session/s-123456", url: "https://dev.test/s" }) }] } });
    }
    if (url.pathname === "/sessions/s-123456") return Response.json({ session: { id: "s-123456", busy: true, running: busy } });
    return Response.json([]);
  },
});
process.env.PAI_KEEP_URL = `http://127.0.0.1:${keep.port}`;
process.env.PAI_DEV_URL = `http://127.0.0.1:${dev.port}`;

const { startServer } = await import("../src/api/server.ts");
const devTasks = await import("../src/domain/dev-tasks.ts");
const messages = await import("../src/domain/messages.ts");

const base = "http://127.0.0.1:8898";
let server: ReturnType<typeof startServer>;
let stop: () => void;

function hook(type: string, page: string, effective?: Record<string, unknown>) {
  const body = JSON.stringify({ type, urn: `keep:page/${page}`, workspace: `keep:page/${WS}`, changed: [], ...(effective ? { effective } : {}) });
  return fetch(`${base}/keep/events`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-keep-signature": `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}` },
    body,
  });
}

async function settle(ms = 300) {
  await Bun.sleep(ms);
}

beforeAll(() => {
  server = startServer();
  stop = devTasks.start();
});

afterAll(async () => {
  stop();
  await server.stop(true);
  keep.stop(true);
  dev.stop(true);
});

describe("keep task → dev session", () => {
  it("starts one session for a created task with an inherited project and writes it back", async () => {
    expect((await hook("page.created", "task", pages.task!.effective)).status).toBe(200);
    await settle();
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ project: { urn: "dev:project/scratch", fields: { worktree: true } }, keep_urn: "keep:page/task", title: "Fix login" });
    expect(String(starts[0]!.brief)).toContain("It loops after sign-in.");
    expect(String(starts[0]!.brief)).toContain("Atma › Scratch › Fix login");
    const set = keepCalls.find((c) => c.tool === "set_properties");
    expect(set?.auth).toBe("Bearer keep_test");
    expect(set?.args.properties).toMatchObject({ "Dev session": [{ urn: "dev:session/s-123456" }], Status: "doing" });
    expect(messages.list({ kinds: ["event"] }).some((m) => m.body === "Started a dev session for Fix login in scratch")).toBe(true);
  });

  it("starts no second session on a duplicate webhook", async () => {
    await Promise.all([hook("page.created", "task"), hook("page.changed", "task")]);
    await settle();
    expect(starts).toHaveLength(1);
  });

  it("does nothing for a page without a project", async () => {
    const before = keepCalls.length;
    await hook("page.created", "plain", {});
    await hook("page.created", "plain");
    await hook("page.created", "tasks");
    await settle();
    expect(starts).toHaveLength(1);
    expect(keepCalls.slice(before).every((c) => c.tool === "get_page")).toBe(true);
  });

  it("gives a plain sub-page of a plain project page a session and its own session property", async () => {
    await hook("page.changed", "projpage");
    await settle();
    expect(starts).toHaveLength(1);
    await hook("page.created", "sub");
    await settle();
    expect(starts).toHaveLength(2);
    expect(starts[1]).toMatchObject({ keep_urn: "keep:page/sub", title: "Write docs" });
    const set = keepCalls.findLast((c) => c.tool === "set_properties");
    expect(set?.args.define).toEqual([{ name: "Dev session", type: "extension", extType: "session", multiple: true, extension: "dev" }]);
    expect(set?.args.properties).toEqual({ "Dev session": [{ urn: "dev:session/s-123456", label: "scratch · s-1234" }] });
    expect(pages.projpage!.properties["Dev session"]).toBeUndefined();
  });

  it("moves the task to review when the session stops", async () => {
    busy = false;
    await devTasks.sync();
    expect(pages.task!.properties.Status).toBe("review");
    const writes = keepCalls.filter((c) => c.tool === "set_properties").length;
    await devTasks.sync();
    expect(keepCalls.filter((c) => c.tool === "set_properties")).toHaveLength(writes);
  });
});
