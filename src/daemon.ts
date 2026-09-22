import { mkdirSync } from "node:fs";
import { config } from "./core/config.ts";
import { refresh } from "./domain/catalog.ts";
import { restoreDaemonJob, startServer } from "./api/server.ts";
import { killAll, noteInterrupted, reapIdle, relayTasksToMain, resumeInterrupted, warmUp, watchMemory } from "./domain/sessions.ts";
import { closeAll as closeTerminals } from "./domain/terminals.ts";
import { startBrowser } from "./domain/browser.ts";
import { startEditor } from "./domain/editor.ts";
import { startPublic } from "./domain/publish.ts";
import { bus } from "./core/bus.ts";
import { startAutoUpdate } from "./host/update.ts";
import { startAutomations } from "./domain/automations.ts";
import { startModules } from "./modules/index.ts";
import * as external from "./modules/external.ts";
import { logger } from "./core/log.ts";

const log = logger("daemon");

mkdirSync(config.workspace, { recursive: true });
refresh();
// Before anything spawns a session: their tools and prompt come from the modules too.
await external.load();
relayTasksToMain();
const stopMemoryWatch = watchMemory();
const server = startServer();
const stopBrowser = startBrowser();
const stopEditor = startEditor();
const stopPublic = startPublic();
// Before warmUp: it revives the main session, whose freshly persisted state would
// otherwise look like a turn that a restart cut off.
resumeInterrupted();
warmUp();
const stopAutoUpdate = startAutoUpdate();
const stopAutomations = startAutomations();
const stopModules = startModules();
await external.startAll();

const catalogTimer = setInterval(refresh, 15 * 60 * 1000);
const reaper = setInterval(reapIdle, 60 * 1000);

bus.emitEvent("daemon.started", { pid: process.pid, port: config.port });

function shutdown(signal: string) {
  log.info(`${signal} — shutting down`);
  clearInterval(catalogTimer);
  clearInterval(reaper);
  stopAutoUpdate?.();
  stopAutomations();
  stopMemoryWatch();
  stopModules();
  void external.stopAll();
  noteInterrupted();
  killAll();
  closeTerminals();
  stopBrowser();
  stopEditor();
  stopPublic();
  void server.stop(true);
  restoreDaemonJob();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

log.info(`pai up — workspace ${config.workspace}, modules ${external.active().map((m) => m.name).join(", ") || "none"}`);
