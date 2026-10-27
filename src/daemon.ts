import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { config, setting } from "./core/config.ts";
import { restoreDaemonJob, startServer } from "./api/server.ts";
import { killAll, noteInterrupted, reapIdle, relayToParent, resumeInterrupted, warmUp, watchMemory } from "./domain/sessions.ts";
import { closeAll as closeTerminals } from "./domain/terminals.ts";
import { startBrowser } from "./domain/browser.ts";
import { bus } from "./core/bus.ts";
import { startAutoUpdate } from "./domain/update.ts";
import { startLinkedInCheck } from "./domain/linkedin-check.ts";
import { startBrowserCheck } from "./domain/browser-check.ts";
import { startAutomations } from "./domain/automations.ts";
import { startModules } from "./modules/index.ts";
import * as connectors from "./connectors/loader.ts";
import * as telegram from "./clients/telegram.ts";
import { logger } from "./core/log.ts";
import * as agents from "./domain/agents.ts";
import { startRates } from "./domain/rates.ts";
import * as main from "./domain/main.ts";
import * as automations from "./domain/automations.ts";
import * as triage from "./domain/triage.ts";
import * as briefs from "./domain/briefs.ts";
import * as recall from "./domain/recall.ts";
import * as summaries from "./domain/summaries.ts";
import * as spend from "./domain/spend.ts";
import * as models from "./domain/models.ts";
import { flush as flushNotices } from "./domain/asks.ts";
import { startClaudeLoginCheck } from "./domain/claude-login.ts";
import * as dev from "./domain/dev.ts";
import * as held from "./domain/held.ts";
import * as mirror from "./domain/mirror.ts";
import * as projects from "./domain/projects.ts";
import { startReleaseCheck } from "./domain/release-check.ts";

const log = logger("daemon");

mkdirSync(config.workspace, { recursive: true });
// Before anything spawns a session: their tools and instructions come from the connectors too.
await connectors.load();
// The repositories are dev's (a separate system on this box); terminals' conversations are followed here.
projects.provide("dev", dev.source);
held.provide("mirror", mirror.held);
const stopDev = await dev.start();
relayToParent();
// pai and its staff: the agents' turns, the one chat, routines feeding both.
const stopAgents = agents.start();
const stopRates = startRates();
const stopMain = main.start();
automations.link({ turn: main.system, triage: triage.add, fields: { brief: briefs.morning, digest: briefs.evening } });
automations.seed();
const stopMemoryWatch = watchMemory();
const stopClaudeLoginCheck = startClaudeLoginCheck();
const server = startServer();
const stopBrowser = startBrowser();
// Before warmUp: it revives the main session, whose freshly persisted state would
// otherwise look like a turn that a restart cut off.
resumeInterrupted();
warmUp();
const stopAutoUpdate = startAutoUpdate();
const stopLinkedInCheck = startLinkedInCheck();
const stopBrowserCheck = startBrowserCheck();
const stopAutomations = startAutomations();
const stopModules = startModules();
await connectors.startAll();
// pai's own Telegram client, the bot he talks to pai through; after the connectors, since his account transcribes its voice.
const bot =
  setting("TELEGRAM_BOT_TOKEN") && setting("TELEGRAM_CHAT_ID") && setting("PAI_NO_TELEGRAM") !== "1"
    ? telegram.startTelegram({ token: setting("TELEGRAM_BOT_TOKEN")!, chatId: Number(setting("TELEGRAM_CHAT_ID")), baseUrl: config.baseUrl, inbox: join(config.workspace, "inbox") })
    : undefined;
// After the connectors and the bot: the chat is listening when terminal threads are announced.
const stopMirror = mirror.start();
const stopReleaseCheck = startReleaseCheck();
const stopRecall = recall.start();
const stopSummaries = summaries.start();
const stopSpend = spend.start();
const stopModels = models.start();
// Notices and asks held through quiet hours go out when they end.
const noticeTimer = setInterval(flushNotices, 60 * 1000);

const reaper = setInterval(reapIdle, 60 * 1000);

bus.emitEvent("daemon.started", { pid: process.pid, port: config.port });

function shutdown(signal: string) {
  log.info(`${signal} — shutting down`);
  clearInterval(reaper);
  clearInterval(noticeTimer);
  stopLinkedInCheck();
  stopBrowserCheck();
  stopRecall();
  stopSummaries();
  stopSpend();
  stopModels();
  stopMain();
  stopAgents();
  stopRates();
  stopAutoUpdate();
  stopAutomations();
  stopMemoryWatch();
  stopClaudeLoginCheck();
  stopModules();
  stopMirror();
  stopReleaseCheck();
  stopDev();
  void connectors.stopAll();
  void bot?.stop();
  noteInterrupted();
  killAll();
  closeTerminals();
  stopBrowser();
  void server.stop(true);
  restoreDaemonJob();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

log.info(`pai up — workspace ${config.workspace}, connectors ${connectors.active().map((m) => m.name).join(", ") || "none"}, bot ${bot ? "on" : "off"}`);
