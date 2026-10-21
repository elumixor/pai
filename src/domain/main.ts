import { bus, waitFor, type PaiEvent } from "../core/bus.ts";
import { kv } from "../core/db.ts";
import { logger } from "../core/log.ts";
import { stamp, zoned } from "../core/time.ts";
import { config } from "../core/config.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as agents from "./agents.ts";
import { attach, type Upload } from "./attachments.ts";
import type { RichPlace } from "../protocol/rich.ts";
import * as asks from "./asks.ts";
import * as gate from "./gate.ts";
import * as journal from "./journal.ts";
import * as limits from "./limits.ts";
import { isLimit } from "./limits.ts";
import * as messages from "./messages.ts";
import * as requests from "./requests.ts";
import type { Session } from "./session.ts";
import * as sessions from "./sessions.ts";
import * as tasks from "./tasks.ts";

const log = logger("main");

/**
 * The one chat: pai, the orchestrator, as one long-lived conversation. Telegram's pai topic,
 * Paigram's bot chat and `pai dev say` all land here. The chat feels endless but no session is:
 * at 04:00, or once the context passes half the window, pai writes the day into the journal and
 * a fresh session starts from a briefing (open tasks, open asks, the agents, yesterday's journal,
 * the last messages). The user sees no break; the old transcript stays searchable.
 */

const THREAD_KEY = "main_thread_id";
const ROTATED_DAY = "main_rotated_day";
/** His last message, kept only so a turn the account's limit killed can be asked again. */
const LAST_USER = "main_last_user";
/** Rotated a little before the session would compact on its own (`compactWindow`), so the journal is written by a session that still remembers the day. */
const ROTATE_AT_TOKENS = () => config.compactWindow * 0.75;
const BRIEFING_MESSAGES = 20;

let rotating: Promise<void> | undefined;

/** The Telegram topic pai's chat lives in; the bot tells it once it has one. */
export function setThread(threadId: number | null) {
  if (threadId === null) kv.del(THREAD_KEY);
  else kv.set(THREAD_KEY, String(threadId));
  const s = live();
  if (s && s.threadId !== threadId) {
    s.threadId = threadId;
    s.persist();
  }
}

export function thread(): number | null {
  const v = kv.get(THREAD_KEY);
  return v ? Number(v) : null;
}

/** The session if one is up or can be revived, without starting a fresh one. */
function live(): Session | undefined {
  const pai = agents.ensurePai();
  return pai.sessionId ? sessions.ensureLive(pai.sessionId) : undefined;
}

/** pai's session: the current one, revived from its transcript if its process is gone, or a fresh one. */
export function session(): Session {
  return live() ?? fresh("first start");
}

export const id = () => agents.get(agents.PAI)?.sessionId ?? null;
export const isMain = (sessionId: string | undefined) => Boolean(sessionId && sessionId === id());

function fresh(reason: string): Session {
  const pai = agents.ensurePai();
  const s = sessions.spawnTask({ title: "pai", threadId: thread(), agent: agents.setupOf(pai) });
  agents.adoptSession(s.id);
  kv.set(ROTATED_DAY, journal.logicalDay());
  s.inject(briefing(reason));
  log.info(`pai session ${s.shortId} (${reason})`);
  return s;
}

/** A message from the user to pai. Open asks ride along, so a plain reply can answer one. */
export function send(text: string, opts: { images?: readonly Upload[]; place?: RichPlace } = {}) {
  const s = session();
  // Kept before the turn: the row carries what he attached, so every client draws it.
  kv.set(LAST_USER, text);
  const attached = attach(opts.images);
  messages.log({ from: "user", to: agents.PAI, kind: "chat", body: text, meta: { ...attached.meta, ...(opts.place ? { place: opts.place } : {}) } });
  if (s.pending) {
    s.answer(text);
    return s;
  }
  const open = asks.open();
  if (open.length) s.inject(`[open asks — if the user's next message answers one, call answer_ask]\n${open.map((a) => `#${a.id} ${agents.breadcrumb(a.agent)}: ${a.question}${a.options.length ? ` (${a.options.join(" / ")})` : ""}`).join("\n")}`);
  // Pictures go to the model as pictures; a file goes as a line naming it, its size and where to
  // read it — a PDF reaches Claude through the Read tool, not as bytes in the turn.
  s.send(attached.fileRefs ? `${text}\n\n${attached.fileRefs}`.trim() : text, {
    images: attached.images.map((i) => ({ media_type: i.media_type, data: i.data })),
    origin: "user",
  });
  return s;
}

/**
 * pai's turn died on the account's limit. The limit is the account's, so nothing it was asked is
 * wrong: the row says so in one quiet line and the same message is sent again once the window
 * reopens — his words are never silently dropped because the account was out of room.
 */
const LIMIT_HELD = "main_limit_held";
function heldByLimit(text: string) {
  const at = limits.resetAt(text);
  const last = kv.get(LAST_USER) ?? "";
  messages.event(agents.PAI, "rate_limited", limits.limitLine("pai", at), { to: "user" });
  if (last) kv.set(LIMIT_HELD, JSON.stringify({ at, text: last }));
  log.info(`pai hit the account's limit; its turn is held until ${new Date(at).toISOString()}`);
}

/** The held turn, sent again once the window has reopened. */
function drainLimitHeld(now = Date.now()) {
  const stored = kv.get(LIMIT_HELD);
  if (!stored) return;
  try {
    const { at, text } = JSON.parse(stored) as { at: number; text: string };
    if (at > now) return;
    kv.set(LIMIT_HELD, "");
    log.info("the limit window reopened; asking pai again");
    session().send(`[the account's limit stopped this before it was answered]\n${text}`, { origin: "system" });
  } catch {
    kv.set(LIMIT_HELD, "");
  }
}

/** The daemon speaking to pai (a report it waits for, a routine, an answer): a turn, not the user's. */
export function system(text: string) {
  session().send(text, { origin: "system" });
}

/** Housekeeping pai does on its own (routing a request): whatever it says stays out of the chat. */
export function silent(text: string) {
  session().send(text, { origin: "silent" });
}

/** Context for pai's next turn without spending one now. */
export function note(text: string) {
  session().inject(text);
}

function briefing(reason: string): string {
  const open = tasks.list({ limit: 40 });
  const waiting = asks.open();
  const staff = agents.list().filter((a) => a.kind !== "orchestrator");
  const today = journal.logicalDay();
  const yesterday = journal.previous(today);
  const chat = messages.chatWithPai(BRIEFING_MESSAGES);
  const parts = [
    `# Briefing — a fresh session for pai, ${stamp()} (${reason})`,
    "You are pai, continuing an ongoing chat with the user; nothing here is new to them. Pick up where the conversation left off.",
    `## Open tasks (${open.length})\n${open.map(tasks.line).join("\n") || "none"}`,
    `## Waiting on the user (${waiting.length})\n${waiting.map((a) => `#${a.id} ${agents.breadcrumb(a.agent)}: ${a.question}`).join("\n") || "nothing"}`,
    `## Your staff (${staff.length})\n${staff.map((a) => `- ${a.slug} · ${a.name} · ${a.kind} · ${a.status} — ${a.brief.split("\n")[0]!.slice(0, 160)}`).join("\n") || "none yet"}`,
    `## Journal ${yesterday}\n${journal.read(yesterday).trim().slice(-6000) || "(empty)"}`,
  ];
  const sofar = journal.read(today).trim();
  if (sofar) parts.push(`## Journal ${today} so far\n${sofar.slice(-4000)}`);
  parts.push(`## The last ${chat.length} messages\n${chat.map((m) => `${m.from === "user" ? "user" : "pai"} (${stamp(m.createdAt)}): ${m.body.replace(/\s+/g, " ").slice(0, 600)}`).join("\n") || "none"}`);
  return parts.join("\n\n");
}

/**
 * Rebuilds pai's session: the old one writes the day into the journal and its lasting facts
 * into memory, then a fresh one starts from a briefing. Waits for a turn in flight.
 */
export function rotate(reason: string): Promise<void> {
  rotating ??= (async () => {
    const old = live();
    const writes = journal.logicalDay();
    const day = reason === "daily" ? journal.previous(writes) : writes;
    try {
      if (old && old.turns > 0) {
        for (let i = 0; i < 120 && (old.state === "busy" || old.pending); i++) await Bun.sleep(5_000);
        const done = waitFor("session.turn_end", old.id, 10 * 60_000);
        old.send(
          `[rotation] Your session is about to be rebuilt from a briefing (${reason}). Before it is: append a "## Summary" to journal/${day}.md — what the user asked, what was decided, what the agents did, what is left open, in short lines; put lasting facts about the user into MEMORY.md (the profile, under about 150 lines) and anything about a person into people/<name>.md. End the turn with no text.`,
          { origin: "system" },
        );
        await done.catch((err: Error) => log.warn(`journal turn: ${err.message}`));
      }
    } finally {
      old?.kill();
      fresh(reason);
      bus.emitEvent("main.rotated", { reason, day });
      rotating = undefined;
    }
  })();
  return rotating;
}

/**
 * Follows pai's turns: its replies go into the message log, a full context rotates the session,
 * and the clock rotates it daily. Agents' reports reach it through `agents.linkPai`.
 */
export function start() {
  agents.linkPai({ note, turn: (text) => void gate.screen(text, { turn: system, note }) });
  requests.linkPai(system, silent);
  requests.wire();
  asks.link({
    priority: (slug) => agents.get(slug)?.priority ?? 0,
    breadcrumb: agents.breadcrumb,
    park: (slug) => slug !== agents.PAI && agents.park(slug),
    deliver: (slug, text, opts) => (slug === agents.PAI ? system(text) : agents.deliver(slug, text, opts)),
    note: (slug, text) => (slug === agents.PAI ? note(text) : agents.noteTo(slug, text)),
  });
  const unwireTasks = asks.wireTasks();
  // A message that met a dead login got no answer; once the login is back, pai answers it.
  let unanswered = false;
  const handler = (e: PaiEvent) => {
    if (e.kind === "claude.auth_failed" && isMain(e.sessionId) && e.payload.origin === "user") unanswered = true;
    if (e.kind === "claude.login_restored" && unanswered) {
      unanswered = false;
      system("[Claude was signed out on the box until now, so the user's last messages went unanswered. Answer them now.]");
    }
    if (e.kind !== "session.turn_end" || !isMain(e.sessionId)) return;
    gate.turnTaken();
    const text = String(e.payload.text ?? "").trim();
    // "No response needed." on a system turn is pai obeying the prompt out loud: not a message.
    // The account's limit is not pai talking: an event row, and the message it never answered is asked again.
    if (text && isLimit(text)) heldByLimit(text);
    else if (text && e.payload.origin !== "silent" && !(e.payload.origin === "system" && gate.boilerplate(text))) messages.log({ from: agents.PAI, to: "user", kind: "chat", body: text, meta: { origin: String(e.payload.origin ?? "user") } });
    void sessions
      .find(e.sessionId!)
      ?.contextUsage()
      .then((u) => {
        if (u && u.totalTokens >= ROTATE_AT_TOKENS() && !rotating) void rotate(`context at ${Math.round(u.totalTokens / 1000)}k tokens`);
      });
  };
  bus.on("event", handler);
  const profile = setTimeout(fillProfile, 10 * 60_000);
  const clock = setInterval(() => {
    drainLimitHeld();
    const z = zoned();
    if (z.hour >= config.rotateHour && kv.get(ROTATED_DAY) !== journal.logicalDay() && !rotating && agents.get(agents.PAI)?.sessionId) void rotate("daily");
  }, 60_000);
  return () => {
    bus.off("event", handler);
    unwireTasks();
    clearInterval(clock);
    clearTimeout(profile);
  };
}

const PROFILE_FILLED = "profile_filled";

/**
 * The profile starts from what pai already knows: once, when MEMORY.md is thin, pai goes through
 * its past conversations (recall, after the archive has had a few minutes to fill) and writes it.
 */
function fillProfile() {
  if (kv.get(PROFILE_FILLED)) return;
  const file = join(config.workspace, "MEMORY.md");
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l) => l.trim().startsWith("-")).length : 0;
  kv.set(PROFILE_FILLED, new Date().toISOString());
  if (lines >= 15) return;
  silent(
    "[profile] MEMORY.md is the user's profile and it is nearly empty. Fill it from what you already know: use recall over past conversations (search the user's name, their companies and projects, family, places, tools, preferences, recurring people) and the workspace. Lasting facts only, one per line, grouped under short headings, under about 150 lines, absolute dates. Facts about other people go into people/<name>.md. End with no text.",
  );
}

/** The logical day pai's session last started over. */
export const lastRotation = () => kv.get(ROTATED_DAY) ?? null;
