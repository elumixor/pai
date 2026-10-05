import { mkdirSync } from "node:fs";
import { config } from "./core/config.ts";
import { refresh } from "./domain/catalog.ts";
import { restoreDaemonJob, startServer } from "./api/server.ts";
import { killAll, noteInterrupted, reapIdle, relayToParent, resumeInterrupted, warmUp, watchMemory } from "./domain/sessions.ts";
import { closeAll as closeTerminals } from "./domain/terminals.ts";
import { startBrowser } from "./domain/browser.ts";
import { startEditor } from "./domain/editor.ts";
import { startPublic } from "./domain/publish.ts";
import { bus } from "./core/bus.ts";
import { startAutoUpdate } from "./host/update.ts";
import { startAutomations } from "./domain/automations.ts";
import { startModules } from "./modules/index.ts";
import * as external from "./modules/external.ts";
import { start as startMirror } from "./domain/mirror.ts";
import { logger } from "./core/log.ts";
import * as agents from "./domain/agents.ts";
import * as main from "./domain/main.ts";
import * as automations from "./domain/automations.ts";
import * as triage from "./domain/triage.ts";
import * as briefs from "./domain/briefs.ts";
import * as recall from "./domain/recall.ts";
import * as staff from "./domain/staff.ts";
import { flush as flushNotices } from "./domain/asks.ts";

const log = logger("daemon");

mkdirSync(config.workspace, { recursive: true });
refresh();
// Before anything spawns a session: their tools and prompt come from the modules too.
await external.load();
relayToParent();
// pai and its staff: the agents' turns, the one chat, routines feeding both.
const stopAgents = agents.start();
const stopMain = main.start();
automations.link({ turn: main.system, triage: triage.add, fields: { brief: briefs.morning, digest: briefs.evening } });
automations.seed();
staff.seed();
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
// After the modules: the chat has to be listening when the threads held in terminals are announced.
const stopMirror = startMirror();
const stopRecall = recall.start();
// Notices and asks held through quiet hours go out when they end.
const noticeTimer = setInterval(flushNotices, 60 * 1000);

const catalogTimer = setInterval(refresh, 15 * 60 * 1000);
const reaper = setInterval(reapIdle, 60 * 1000);

bus.emitEvent("daemon.started", { pid: process.pid, port: config.port });

function shutdown(signal: string) {
  log.info(`${signal} — shutting down`);
  clearInterval(catalogTimer);
  clearInterval(reaper);
  clearInterval(noticeTimer);
  stopRecall();
  stopMain();
  stopAgents();
  stopAutoUpdate?.();
  stopAutomations();
  stopMemoryWatch();
  stopModules();
  stopMirror();
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
