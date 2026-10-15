import { afterAll, describe, expect, it } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "pai-mirror-"));
process.env.PAI_CLAUDE_PROJECTS = join(root, "projects");
process.env.PAI_DB = join(root, "pai.db");
process.env.PAI_WORKSPACE = join(root, "workspace");
process.env.PAI_DEV_ROOT = join(root, "dev");
mkdirSync(process.env.PAI_WORKSPACE, { recursive: true });
const { bus } = await import("../core/bus.ts");
const mirror = await import("./mirror.ts");
const channels = await import("./channels.ts");

const dir = join(process.env.PAI_CLAUDE_PROJECTS, process.env.PAI_WORKSPACE.replace(/[/.]/g, "-"));
mkdirSync(dir, { recursive: true });
const id = "0f0f0f0f-1111-2222-3333-444444444444";
const file = join(dir, `${id}.jsonl`);
const lines = (entries: unknown[]) => entries.map((e) => `${JSON.stringify(e)}\n`).join("");
const cli = { entrypoint: "cli", sessionId: id };

const seen: { kind: string; payload: Record<string, unknown> }[] = [];
bus.on("event", (e) => e.sessionId === id && seen.push({ kind: e.kind, payload: e.payload }));
const stop = mirror.start();
afterAll(stop);

async function until(kind: string, count = 1) {
  for (let i = 0; i < 40 && seen.filter((e) => e.kind === kind).length < count; i++) await Bun.sleep(100);
}

describe("mirror", () => {
  it("tells a terminal's new conversation to the bus as a thread", async () => {
    writeFileSync(
      file,
      lines([
        { type: "permission-mode", permissionMode: "default" },
        { ...cli, type: "user", origin: { kind: "human" }, message: { role: "user", content: "is the box in sync?" } },
        { ...cli, type: "assistant", message: { content: [{ type: "text", text: "Checking." }] } },
        { ...cli, type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "pai files status" } }] } },
        { ...cli, type: "user", toolUseResult: {}, message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "in sync" }] } },
        { ...cli, type: "assistant", message: { content: [{ type: "text", text: "Yes, in sync." }] } },
        { type: "ai-title", aiTitle: "Box sync", sessionId: id },
        { ...cli, type: "system", subtype: "turn_duration", durationMs: 4200 },
      ]),
    );
    await until("session.turn_end");
    expect(seen.map((e) => e.kind)).toEqual(["task.created", "session.input", "session.text", "session.tool", "session.turn_end"]);
    expect(seen[1]!.payload).toMatchObject({ text: "is the box in sync?", echo: true, terminal: true });
    expect(seen[2]!.payload).toMatchObject({ text: "Checking.", flush: true });
    expect(seen[3]!.payload).toMatchObject({ name: "Bash" });
    expect(seen[4]!.payload).toMatchObject({ text: "Yes, in sync.", durationMs: 4200 });
    const thread = mirror.find(id)!;
    expect(thread.title).toBe("Box sync");
    expect(thread.state).toBe("idle");
    expect(thread.turns).toBe(1);
  });

  it("starts a turn without echoing what came in through the channel", async () => {
    seen.length = 0;
    appendFileSync(
      file,
      lines([
        { ...cli, type: "user", origin: { kind: "channel", server: "pai" }, message: { role: "user", content: '<channel source="pai">and now?</channel>' } },
        { ...cli, type: "assistant", message: { content: [{ type: "text", text: "Still in sync." }] } },
      ]),
    );
    await until("session.input");
    expect(seen[0]).toMatchObject({ kind: "session.input", payload: { text: "" } });
    expect(seen[0]!.payload.echo).toBeUndefined();
    expect(mirror.find(id)!.state).toBe("busy");
    // A line still being written waits for its end.
    appendFileSync(file, JSON.stringify({ ...cli, type: "system", subtype: "turn_duration", durationMs: 900 }));
    await Bun.sleep(1800);
    expect(seen.some((e) => e.kind === "session.turn_end")).toBe(false);
    appendFileSync(file, "\n");
    await until("session.turn_end");
    expect(seen.at(-1)).toMatchObject({ kind: "session.turn_end", payload: { text: "Still in sync.", durationMs: 900 } });
  });

  it("hands a message for the thread to its terminal while one is connected", async () => {
    const res = channels.stream(id);
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    expect((await reader.read()).value).toContain("connected");
    mirror.find(id)!.send("one more thing");
    expect((await reader.read()).value).toBe(`data: ${JSON.stringify({ text: "one more thing", images: [] })}\n\n`);
    // Pictures go down with it, named as the daemon keeps them, so the terminal can save its own copy.
    const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    mirror.find(id)!.send("and this", { images: [{ media_type: "image/png", data }] });
    const sent = JSON.parse(((await reader.read()).value ?? "").replace(/^data: /, ""));
    expect(sent).toMatchObject({ text: "and this", images: [{ media_type: "image/png", data, name: expect.stringMatching(/^[0-9a-f]{16}\.png$/) }] });
    await reader.cancel();
    await Bun.sleep(50); // the cancel travels up the pipe on its own time
    expect(channels.connected(id)).toBe(false);
  });
});
