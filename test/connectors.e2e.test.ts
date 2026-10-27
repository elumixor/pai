import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The daemon reads its configuration once, at import: scratch database, workspace and port first.
const scratch = mkdtempSync(join(tmpdir(), "pai-connectors-"));
process.env.PAI_DB = join(scratch, "pai.db");
process.env.PAI_CONFIG = join(scratch, "config.json");
process.env.PAI_WORKSPACE = join(scratch, "workspace");
process.env.PAI_PORT = "8897";
process.env.PAI_BIND = "127.0.0.1";
process.env.PAI_NO_TELEGRAM = "1";
process.env.PAI_NO_EDITOR = "1";
process.env.PAI_CLAUDE_PROJECTS = join(scratch, "claude-projects");

const external = await import("../src/modules/external.ts");
const { startServer } = await import("../src/api/server.ts");

const CONNECTORS = ["telegram", "email", "linkedin", "whatsapp"];
// The real modules, loaded as the daemon loads them (not started), only where they are installed:
// loading would otherwise clone them, which a checkout without the GitHub key cannot.
const installed = CONNECTORS.every(external.isInstalled);

let server: ReturnType<typeof startServer> | undefined;

beforeAll(async () => {
  if (!installed) return;
  await external.load();
  server = startServer();
});

afterAll(async () => {
  await server?.stop(true);
});

describe("connectors", () => {
  it.skipIf(!installed)("lists every connector module in config order, each with a status", async () => {
    const res = await fetch("http://127.0.0.1:8897/connectors");
    expect(res.status).toBe(200);
    const list = (await res.json()) as { name: string; status: { state: string } }[];
    expect(list.map((c) => c.name)).toEqual(CONNECTORS);
    for (const c of list) expect(["signed_in", "signed_out", "broken"]).toContain(c.status.state);
  });

  it.skipIf(!installed)("keeps the mailbox tools under the gmail server and the old /gmail/ paths", async () => {
    const modules = (await (await fetch("http://127.0.0.1:8897/modules")).json()) as { name: string; tools?: { server: string } }[];
    expect(modules.find((m) => m.name === "email")?.tools?.server).toBe("gmail");
    expect((await fetch("http://127.0.0.1:8897/gmail/accounts")).status).toBe(200);
  });
});
