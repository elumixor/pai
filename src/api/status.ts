import { $ } from "bun";
import { config } from "../core/config.ts";
import * as memory from "../domain/memory.ts";
import { all as allProjects } from "../domain/catalog.ts";
import { editorStatus } from "../domain/editor.ts";
import { publicStatus, publicUrl } from "../domain/publish.ts";
import { syncStatus } from "../domain/sync.ts";

/** What the dashboard shows about the daemon itself: where it runs and how it is set up. */
export async function status() {
  return {
    ok: true,
    pid: process.pid,
    uptime: process.uptime(),
    version: await version(),
    host: {
      hostname: process.env.HOSTNAME ?? (await $`hostname`.nothrow().quiet()).stdout.toString().trim(),
      platform: process.platform,
      baseUrl: config.baseUrl || undefined,
      api: `http://${config.host}:${config.port}`,
      publicUrl: publicUrl(),
    },
    editor: editorStatus(),
    public: publicStatus(),
    sync: syncStatus(),
    settings: {
      workspace: config.workspace,
      devRoot: config.devRoot,
      models: config.models,
      updateChannel: config.updateChannel,
      autoUpdate: config.autoUpdate,
      telegram: config.telegram.enabled,
      tokenSet: Boolean(config.token),
      published: config.public,
      idleShutdownMinutes: Math.round(config.idleShutdownMs / 60000),
    },
    counts: { projects: allProjects().length, memories: memory.all().length },
  };
}

let cached: string | undefined;

async function version() {
  if (cached) return cached;
  const described = await $`git describe --tags --always`.cwd(config.repo).nothrow().quiet();
  cached = described.stdout.toString().trim() || "unknown";
  return cached;
}
