import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The daemon reads its configuration once, at import, so the scratch database and port
// have to be in the environment before anything from src is loaded.
const scratch = mkdtempSync(join(tmpdir(), "pai-e2e-"));
process.env.PAI_DB = join(scratch, "pai.db");
process.env.PAI_PORT = "8899";
// Loopback, not whatever tailnet address this machine has: the test talks to 127.0.0.1.
process.env.PAI_BIND = "127.0.0.1";
process.env.PAI_NO_TELEGRAM = "1";
process.env.PAI_NO_EDITOR = "1";
process.env.PAI_CONFIG = join(scratch, "config.json");
process.env.PAI_CLAUDE_PROJECTS = join(scratch, "claude-projects");

const { startServer } = await import("../src/api/server.ts");
const { closeAll } = await import("../src/domain/terminals.ts");

const base = "http://127.0.0.1:8899";
let server: ReturnType<typeof startServer>;

const get = (path: string) => fetch(`${base}${path}`);
const post = (path: string, payload: unknown) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });

async function waitFor(predicate: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(20);
  }
  return false;
}

beforeAll(() => {
  // The client is a build artefact; a clean checkout (CI) has not made it yet.
  if (!existsSync(join(import.meta.dir, "..", "desktop", "ui", "dist", "index.html"))) {
    const built = Bun.spawnSync({ cmd: ["bun", "run", "build:ui"] });
    if (built.exitCode !== 0) throw new Error("could not build the client for the test run");
  }
  server = startServer();
});

afterAll(async () => {
  closeAll();
  await server.stop(true);
});

describe("api", () => {
  it("reports health, version and settings", async () => {
    const res = await get("/health");
    expect(res.status).toBe(200);
    const status = (await res.json()) as { ok: boolean; version: string; settings: { workspace: string } };
    expect(status.ok).toBe(true);
    expect(status.version).toBeTruthy();
    expect(status.settings.workspace).toBeTruthy();
  });

  it("names the roots it can show, and lists one", async () => {
    const roots = (await (await get("/roots")).json()) as { name: string; path: string }[];
    expect(roots.map((r) => r.name)).toContain("pai");
    const paiRoot = roots.find((r) => r.name === "pai");
    const entries = (await (await get(`/files?path=${encodeURIComponent(paiRoot?.path ?? "")}`)).json()) as {
      name: string;
    }[];
    expect(entries.map((e) => e.name)).toContain("package.json");
  });

  it("reads a file inside a root and refuses one outside", async () => {
    const roots = (await (await get("/roots")).json()) as { name: string; path: string }[];
    const paiRoot = roots.find((r) => r.name === "pai")?.path ?? "";
    const file = (await (await get(`/file?path=${encodeURIComponent(`${paiRoot}/package.json`)}`)).json()) as {
      text: string;
    };
    expect(file.text).toContain("\"name\"");

    const refused = await get("/file?path=%2Fetc%2Fpasswd");
    expect(refused.status).toBe(500);
    expect(await refused.text()).toContain("outside the directories");
  });

  it("lists the documents worth reading", async () => {
    const docs = (await (await get("/docs")).json()) as { name: string }[];
    expect(docs.some((doc) => doc.name.endsWith(".md"))).toBe(true);
  });

  it("lists projects", async () => {
    const res = await get("/projects");
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  it("reads and writes the editable settings", async () => {
    const before = (await (await get("/settings")).json()) as {
      editable: string[];
      effective: Record<string, string>;
      overrides: Record<string, string>;
    };
    expect(before.editable).toContain("PAI_MAIN_MODEL");
    expect(before.effective.PAI_MAIN_MODEL).toBeTruthy();

    const patch = await fetch(`${base}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ PAI_MAIN_MODEL: "opus" }),
    });
    expect(((await patch.json()) as { overrides: Record<string, string> }).overrides.PAI_MAIN_MODEL).toBe("opus");

    const after = (await (await get("/settings")).json()) as { overrides: Record<string, string> };
    expect(after.overrides.PAI_MAIN_MODEL).toBe("opus");

    const refused = await fetch(`${base}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ PATH: "/tmp" }),
    });
    expect(refused.status).toBe(500);
  });

  it("answers with an empty transcript for a session it has never seen", async () => {
    const messages = (await (await get("/transcript?session=nosuch")).json()) as unknown[];
    expect(messages).toEqual([]);
  });

  it("allows another origin to read it", async () => {
    const preflight = await fetch(`${base}/health`, { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect((await get("/health")).headers.get("access-control-allow-origin")).toBe("*");
  });

  it("serves the client bundle at /ui", async () => {
    const res = await get("/ui/");
    expect([200, 503]).toContain(res.status);
  });

  it("404s an unknown route", async () => {
    expect((await get("/nope")).status).toBe(404);
  });

  it("reports recent events", async () => {
    const res = await get("/events");
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });
});

describe("the web app", () => {
  it("redirects the root to the client", async () => {
    const res = await fetch(`${base}/`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/ui/");
  });

  it("serves the built page", async () => {
    const res = await get("/ui/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>pai</title>");
  });

  it("serves the bundle", async () => {
    const res = await get("/ui/main.js");
    expect(res.status).toBe(200);
    expect((await res.text()).length).toBeGreaterThan(1000);
  });

  it("refuses to escape the build directory", async () => {
    const res = await get("/ui/../../package.json");
    expect(await res.text()).not.toContain("\"name\": \"pai\"");
  });
});

describe("the metadata link", () => {
  it("renders what a message carried", async () => {
    const { PROTOCOL_VERSION, encodePayload } = await import("../src/protocol/rich.ts");
    const payload = encodePayload({ v: PROTOCOL_VERSION, kind: "result", session: "abc123", project: "pai" });
    const res = await get(`/m/${payload}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("abc123");
    expect(html).toContain("pai");
  });

  it("says so when the link is unreadable", async () => {
    const res = await get("/m/bm90LWpzb24");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("Nothing to show");
  });
});

describe("terminals over the api", () => {
  it("opens, streams, resizes and closes", async () => {
    const opened = (await (await post("/terminals", { cwd: scratch, cols: 80, rows: 24 })).json()) as {
      id: string;
      cwd: string;
    };
    expect(opened.cwd).toBe(scratch);

    const listed = (await (await get("/terminals")).json()) as { id: string }[];
    expect(listed.map((t) => t.id)).toContain(opened.id);

    const socket = new WebSocket(`ws://127.0.0.1:8899/terminals/${opened.id}/stream`);
    let output = "";
    socket.addEventListener("message", (event) => {
      output += String(event.data);
    });
    expect(await waitFor(() => socket.readyState === WebSocket.OPEN)).toBe(true);

    socket.send("echo e2e-terminal\n");
    expect(await waitFor(() => output.includes("e2e-terminal"))).toBe(true);

    const resized = (await (await post(`/terminals/${opened.id}`, { cols: 100, rows: 30 })).json()) as {
      cols: number;
      rows: number;
    };
    expect(resized).toMatchObject({ cols: 100, rows: 30 });

    socket.close();
    const closed = await fetch(`${base}/terminals/${opened.id}`, { method: "DELETE" });
    expect(await closed.json()).toEqual({ closed: true });
    expect((await get(`/terminals/${opened.id}`)).status).toBe(404);
  });

  it("refuses a stream for a terminal that does not exist", async () => {
    const res = await get("/terminals/deadbeef/stream");
    expect(res.status).toBe(404);
  });
});

describe("pai and its staff over the api", () => {
  const patch = (path: string, payload: unknown) =>
    fetch(`${base}${path}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });

  it("keeps the task list, and still lists sessions for older clients", async () => {
    const created = (await (await post("/tasks", { title: "Prepare for the visit", due: "2026-10-20" })).json()) as { id: number; status: string; createdBy: string };
    expect(created).toMatchObject({ status: "inbox", createdBy: "user" });
    const done = (await (await patch(`/tasks/${created.id}`, { status: "done" })).json()) as { status: string };
    expect(done.status).toBe("done");
    const list = (await (await get("/tasks?all=1")).json()) as { items: { id: number }[]; live: unknown[]; recent: unknown[] };
    expect(list.items.some((t) => t.id === created.id)).toBe(true);
    expect(Array.isArray(list.live) && Array.isArray(list.recent)).toBe(true);
    expect((await post("/tasks", { title: "" })).status).toBe(400);
  });

  it("creates an agent, shows it in the tree and its chat", async () => {
    const res = await post("/agents", { name: "Job search", kind: "standing", brief: "Find a better job." });
    expect(res.status).toBe(201);
    const tree = (await (await get("/agents")).json()) as { slug: string; depth: number; breadcrumb: string }[];
    expect(tree.find((a) => a.slug === "pai")?.depth).toBe(1);
    expect(tree.find((a) => a.slug === "job-search")?.breadcrumb).toBe("pai › Job search");
    const chat = (await (await get("/messages?agent=job-search")).json()) as { kind: string; meta: { event?: string } }[];
    expect(chat.some((m) => m.meta.event === "agent.created")).toBe(true);
    expect((await get("/agents/nobody")).status).toBe(404);
  });

  it("lists and answers nothing when nothing is asked", async () => {
    expect(await (await get("/asks")).json()).toEqual([]);
    expect((await post("/asks/999/answer", { text: "yes" })).status).toBe(400);
    expect(Array.isArray(await (await get("/routines")).json())).toBe(true);
    expect((await post("/routines", { name: "bad", schedule: "every day", action: "turn" })).status).toBe(400);
  });

  it("pins outbound actions and mutes senders", async () => {
    expect(await (await post("/pins", { action: "send email", mode: "ask" })).json()).toEqual([{ action: "send email", mode: "ask" }]);
    const mute = (await (await post("/mutes", { pattern: "newsletter" })).json()) as { id: number };
    expect((await (await fetch(`${base}/mutes?id=${mute.id}`, { method: "DELETE" })).json()) as unknown).toEqual({ removed: true });
  });
});
