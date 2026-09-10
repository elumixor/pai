import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The daemon reads its configuration once, at import, so the scratch database and port
// have to be in the environment before anything from src is loaded.
const scratch = mkdtempSync(join(tmpdir(), "pai-e2e-"));
process.env.PAI_DB = join(scratch, "pai.db");
process.env.PAI_PORT = "8899";
process.env.PAI_NO_TELEGRAM = "1";

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
  server = startServer();
});

afterAll(async () => {
  closeAll();
  await server.stop(true);
});

describe("api", () => {
  it("reports health", async () => {
    const res = await get("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, pid: process.pid });
  });

  it("lists projects", async () => {
    const res = await get("/projects");
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
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
  it("redirects the root to the app", async () => {
    const res = await fetch(`${base}/`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/app/");
  });

  it("serves the built page", async () => {
    const res = await get("/app/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>pai</title>");
  });

  it("serves the bundle", async () => {
    const res = await get("/app/main.js");
    expect(res.status).toBe(200);
    expect((await res.text()).length).toBeGreaterThan(1000);
  });

  it("refuses to escape the build directory", async () => {
    const res = await get("/app/../../package.json");
    expect(await res.text()).not.toContain("\"name\": \"pai\"");
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
