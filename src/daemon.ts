import { config } from "./config.ts";
import { refresh } from "./catalog.ts";
import { startServer } from "./server.ts";
import { startTelegram } from "./telegram.ts";
import { killAll, reapIdle } from "./sessions.ts";
import { bus } from "./bus.ts";
import { logger } from "./log.ts";

const log = logger("daemon");

refresh();
const server = startServer();
const bot = startTelegram();

const catalogTimer = setInterval(refresh, 15 * 60 * 1000);
const reaper = setInterval(reapIdle, 60 * 1000);

bus.emitEvent("daemon.started", { pid: process.pid, port: config.port });

function shutdown(signal: string) {
  log.info(`${signal} — shutting down`);
  clearInterval(catalogTimer);
  clearInterval(reaper);
  killAll();
  void bot?.stop();
  void server.stop(true);
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

log.info(`builder up — projects under ${config.devRoot}, telegram ${bot ? "on" : "off"}`);
