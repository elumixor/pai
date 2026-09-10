import { mkdirSync } from "node:fs";
import { config } from "./core/config.ts";
import { refresh } from "./domain/catalog.ts";
import { restoreDaemonJob, startServer } from "./api/server.ts";
import { startTelegram } from "./clients/telegram.ts";
import { startDashboardPush } from "./clients/dashboard.ts";
import { killAll, reapIdle, relayTasksToMain, warmUp } from "./domain/sessions.ts";
import { closeAll as closeTerminals } from "./domain/terminals.ts";
import { startBrowser } from "./domain/browser.ts";
import { bus } from "./core/bus.ts";
import { disconnectUser } from "./clients/tg-user.ts";
import { startAutoUpdate } from "./host/update.ts";
import { logger } from "./core/log.ts";

const log = logger("daemon");

mkdirSync(config.workspace, { recursive: true });
refresh();
relayTasksToMain();
const server = startServer();
const stopBrowser = startBrowser();
const bot = startTelegram();
warmUp();
const stopDashboard = startDashboardPush();
const stopAutoUpdate = startAutoUpdate();

const catalogTimer = setInterval(refresh, 15 * 60 * 1000);
const reaper = setInterval(reapIdle, 60 * 1000);

bus.emitEvent("daemon.started", { pid: process.pid, port: config.port });

function shutdown(signal: string) {
  log.info(`${signal} — shutting down`);
  clearInterval(catalogTimer);
  clearInterval(reaper);
  stopDashboard?.();
  stopAutoUpdate?.();
  killAll();
  closeTerminals();
  stopBrowser();
  void disconnectUser();
  void bot?.stop();
  void server.stop(true);
  restoreDaemonJob();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

log.info(`pai up — workspace ${config.workspace}, telegram ${bot ? "on" : "off"}`);
