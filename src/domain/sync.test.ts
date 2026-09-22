import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "pai-sync-"));
process.env.PAI_DB = join(scratch, "pai.db");
process.env.PAI_CONFIG = join(scratch, "config.json");

describe("sync, switched off", () => {
  it("reports itself as off and starts nothing", async () => {
    const { startSync, syncStatus, syncProgress } = await import("./sync.ts");
    const stop = startSync();
    expect(syncStatus().enabled).toBe(false);
    expect(syncStatus().running).toBe(false);
    expect(await syncProgress()).toEqual([]);
    stop();
  });

  it("names the three folders it shares", async () => {
    const { syncStatus } = await import("./sync.ts");
    expect(syncStatus().folders.map((folder) => folder.id)).toEqual(["pai-projects", "pai-transcripts", "pai-claude-home"]);
  });
});
