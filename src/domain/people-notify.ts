import { bus } from "../core/bus.ts";
import { config } from "../core/config.ts";
import { db, now } from "../core/db.ts";
import { logger } from "../core/log.ts";
import * as agents from "./agents.ts";
import * as decide from "./decide.ts";
import type { KeepPage } from "./dev-tasks.ts";
import { callKeep, type KeepChange, pageId, signedWith } from "./keep.ts";
import * as keepLinks from "./keep-links.ts";
import * as main from "./main.ts";
import * as sessions from "./sessions.ts";

/**
 * People → pai: People delivers Pai's notifications (Keep mentions, replies, watched changes, shares, invites) as a
 * signed POST to `/people/notify`. Each is stored once (People retries by the same id), acked at once and routed, one
 * at a time, to the thread it belongs to: the thread named by the watch's client tag (`pai:thread/<id>`), else the
 * thread that owns the page (`keep-links.ts`), else Jev picks an existing thread, a new child thread, or the general
 * one (pai main), which is also where anything unclear goes.
 */

const log = logger("people-notify");

export type NotificationType = "mention" | "reply" | "watch" | "share" | "invite";

/** The notification People sends, as Keep made it. */
export interface Notification {
  readonly id: string;
  /** The recipient's People id (Pai's). */
  readonly to: string;
  readonly source: string;
  readonly type: NotificationType;
  readonly title: string;
  readonly text?: string;
  readonly url: string;
  /** `keep:page/<id>`. */
  readonly subject: string;
  /** `people:person/<id>`. */
  readonly actor?: string;
  /** Watch notifications only: the client tag the watch was made with. */
  readonly client?: string;
  readonly createdAt: string;
  readonly data: {
    readonly workspace: string;
    readonly page: string;
    readonly comment?: string;
    readonly mention?: "body" | "title" | "property" | "comment";
    readonly property?: string;
    readonly role?: string;
    readonly changes?: readonly KeepChange[];
    /** A cursor for `read_page` `since`: the diff since the change before this one. */
    readonly since?: string;
    /** The write's client tag; informational. */
    readonly via?: string;
  };
}

export class PeopleNotifyError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401,
  ) {
    super(message);
    this.name = "PeopleNotifyError";
  }
}

/** Where a notification goes: pai itself, one of its agents, or a plain thread. */
export type Target = { kind: "main" } | { kind: "agent"; slug: string } | { kind: "thread"; sessionId: string };
export type Via = "client" | "link" | "decide" | "general";

/** Rows older than this are not routed after a restart: the moment has passed. */
const REQUEUE_MS = 24 * 60 * 60 * 1000;
const MAX_CANDIDATES = 25;
const RECENT = 30;
const EXISTING_AT = 0.5;
const NEW_AT = 0.6;
/** What a new thread can be started for: someone asking Pai something, or handing it a page. */
const SPAWNS = new Set<NotificationType>(["mention", "reply", "share"]);
const KEEP_CLIENT = { client: "pai:people-notify" };

/** The signed body People posted: stored once and queued; a retry of one already received is a duplicate. */
export function receive(body: string, signature: string | null, event: string | null): { ok: true; duplicate?: true; ignored?: true } {
  const secret = config.peopleWebhookSecret;
  if (!secret || !signature || !signedWith(secret, body, signature)) throw new PeopleNotifyError("the body is not signed with PAI_PEOPLE_WEBHOOK_SECRET", 401);
  if (event !== "notification") return { ok: true, ignored: true };
  let n: Notification;
  try {
    n = JSON.parse(body) as Notification;
  } catch {
    throw new PeopleNotifyError("the body is not JSON", 400);
  }
  if (typeof n?.id !== "string" || !n.id || typeof n.type !== "string" || typeof n.subject !== "string") throw new PeopleNotifyError("not a notification", 400);
  const res = db.prepare("INSERT OR IGNORE INTO keep_notifications (id, body, received_at) VALUES (?, ?, ?)").run(n.id, body, now());
  if (res.changes === 0) return { ok: true, duplicate: true };
  bus.emitEvent("people.notification", { id: n.id, type: n.type, subject: n.subject, title: n.title, ...(n.actor ? { actor: n.actor } : {}), ...(n.client ? { client: n.client } : {}) });
  enqueue?.(n.id);
  return { ok: true };
}

/** Set while the router runs; a notification received before it starts is picked up by its re-queue. */
let enqueue: ((id: string) => void) | undefined;

/** Routes what is received, one at a time, and what a restart left un-routed. */
export function start() {
  let queue = Promise.resolve();
  let stopped = false;
  enqueue = (id) => {
    queue = queue.then(() => (stopped ? undefined : handle(id)));
  };
  const pending = db.query("SELECT id FROM keep_notifications WHERE routed_at IS NULL AND received_at > ? ORDER BY received_at").all(now() - REQUEUE_MS) as { id: string }[];
  for (const { id } of pending) enqueue(id);
  return () => {
    stopped = true;
    enqueue = undefined;
  };
}

/** One stored notification: routed, delivered, and marked so it is never routed twice. */
async function handle(id: string) {
  const row = db.query("SELECT body FROM keep_notifications WHERE id = ? AND routed_at IS NULL").get(id) as { body: string } | undefined;
  if (!row) return;
  const n = JSON.parse(row.body) as Notification;
  let via: Via = "general";
  let target: Target = { kind: "main" };
  let error: string | null = null;
  try {
    ({ via, target } = await route(n));
  } catch (err) {
    error = (err as Error).message;
    log.warn(`${id}: ${error}`);
  }
  try {
    target = deliver(target, n);
  } catch (err) {
    error = (err as Error).message;
    log.warn(`${id}: delivering to ${label(target)}: ${error}`);
    if (target.kind !== "main") {
      target = { kind: "main" };
      try {
        main.system(render(n));
      } catch (again) {
        error = `${error}; main: ${(again as Error).message}`;
      }
    }
  }
  db.prepare("UPDATE keep_notifications SET routed_at = ?, via = ?, routed_to = ?, error = ? WHERE id = ?").run(now(), via, label(target), error, id);
  log.info(`${id} ${n.type} ${n.subject} → ${label(target)} (${via})`);
}

const label = (t: Target) => (t.kind === "main" ? "main" : t.kind === "agent" ? `agent:${t.slug}` : `thread:${t.sessionId}`);

/** The page a notification is about: the comment's page or the subject. */
const pageOf = (n: Notification) => keepLinks.pageUrn(n.data?.page || n.subject);

/** Where a session's turns go: an old main session still means pai, an agent's means that agent while it is open. */
export function targetOf(sessionId: string | undefined): Target | undefined {
  if (!sessionId) return undefined;
  const row = db.query("SELECT agent FROM sessions WHERE session_id = ?").get(sessionId) as { agent: string | null } | undefined;
  if (!row) return undefined;
  if (row.agent === agents.PAI) return { kind: "main" };
  if (row.agent) return agents.get(row.agent)?.status === "closed" ? undefined : { kind: "agent", slug: row.agent };
  return { kind: "thread", sessionId };
}

/** Where a notification goes, without delivering it; a new thread is started (and linked) here. */
export async function route(n: Notification): Promise<{ via: Via; target: Target }> {
  const tagged = /^pai:thread\/(.+)$/.exec(n.client ?? "")?.[1];
  const byClient = targetOf(tagged ? sessions.resolveId(tagged) : undefined);
  if (byClient) return { via: "client", target: byClient };
  const page = pageOf(n);
  const byLink = targetOf(keepLinks.threadFor(page));
  if (byLink) return { via: "link", target: byLink };
  if (n.type === "invite" || !decide.enabled()) return { via: "general", target: { kind: "main" } };
  return decideRoute(n, page);
}

interface Candidate {
  readonly sessionId: string;
  readonly target: Target;
  readonly title: string;
}

/** Jev: one of the threads near the page, a new child thread, or the general one. */
async function decideRoute(n: Notification, page: string): Promise<{ via: Via; target: Target }> {
  const info = await callKeep<KeepPage & { ancestors?: { id: string; urn?: string; title: string }[] }>("read_page", { id: pageId(page) }, KEEP_CLIENT).catch((err: Error) => {
    log.debug(`read_page ${page}: ${err.message}`);
    return undefined;
  });
  // Nearest first: a thread owning the page above is the likeliest home, and the parent of a new one.
  const near: Candidate[] = [];
  for (const a of [...(info?.ancestors ?? [])].reverse()) {
    const sessionId = keepLinks.threadFor(a.urn ?? a.id);
    const target = targetOf(sessionId);
    if (sessionId && target && !near.some((c) => c.sessionId === sessionId)) near.push({ sessionId, target, title: a.title });
  }
  const recent = sessions
    .recent(RECENT)
    .filter((s) => !s.agent && (s.state === "idle" || s.state === "busy" || s.state === "starting") && !near.some((c) => c.sessionId === s.sessionId))
    .map((s): Candidate => ({ sessionId: s.sessionId, target: { kind: "thread", sessionId: s.sessionId }, title: s.title }));
  const candidates = [...near, ...recent].slice(0, MAX_CANDIDATES);
  const keys = new Map(candidates.map((c, i) => [`t${i + 1}`, c]));
  const pagesLine = (c: Candidate) => {
    const titles = keepLinks.pagesOf(c.sessionId).map((p) => p.title).filter(Boolean);
    return titles.length ? ` · pages: ${titles.slice(0, 5).join(", ")}` : "";
  };
  const state = {
    notification: {
      type: n.type,
      title: n.title,
      text: (n.text ?? "").replace(/\s+/g, " ").slice(0, 1500),
      page: info ? [...(info.path ?? []), info.title].filter(Boolean).join(" › ") : page,
    },
  };
  const target: decide.Choice = {
    type: "choice",
    instructions: "Where should Pai handle this Keep `notification`?",
    criteria: {
      general: "Nothing clearly belongs to one thread, or it is a one-line piece of information",
      ...(candidates.length ? { existing: "One of the listed threads is already doing this work" } : {}),
      new: "A new, well-scoped piece of work that deserves its own thread",
    },
  };
  const thread: decide.Choice | undefined = candidates.length
    ? { type: "choice", instructions: "Which thread is already doing the work `notification` is about?", criteria: { none: "None of them", ...Object.fromEntries([...keys].map(([k, c]) => [k, `${c.title.slice(0, 100)}${pagesLine(c)}`])) } }
    : undefined;
  const a = await decide.ask(state, { target, ...(thread ? { thread } : {}) });
  const chosen = a.thread && a.thread.choice !== "none" ? keys.get(a.thread.choice) : undefined;
  if (chosen && decide.probability(a.target, "existing") >= EXISTING_AT && decide.probability(a.thread!, a.thread!.choice) >= EXISTING_AT) return { via: "decide", target: chosen.target };
  if (decide.probability(a.target, "new") >= NEW_AT && SPAWNS.has(n.type)) {
    const parent = near[0] ? (near[0].target.kind === "main" ? main.id() : near[0].sessionId) : main.id();
    return { via: "decide", target: spawnFor(n, page, info, parent) };
  }
  return { via: "decide", target: { kind: "main" } };
}

/** A new thread for the page, linked to it and briefed; when another thread took the page meanwhile, that one. */
function spawnFor(n: Notification, page: string, info: KeepPage | undefined, parent: string | null): Target {
  const owner = targetOf(keepLinks.threadFor(page));
  if (owner) return owner;
  const title = (info?.title || n.title).slice(0, 60);
  const s = sessions.spawnTask({ title, parent, origin: "keep" });
  if (!keepLinks.link(page, s.id, { title: info?.title ?? "" })) return targetOf(keepLinks.threadFor(page)) ?? { kind: "main" };
  s.inject(brief(page, info));
  return { kind: "thread", sessionId: s.id };
}

/** What a new thread is told about the page it now owns, before the notification itself. */
export function brief(page: string, info: KeepPage | undefined) {
  const above = (info?.path ?? []).filter(Boolean);
  return [
    `# ${info?.title || page}`,
    `This thread owns the Keep page ${page}: its notifications come here. Read it whole with read_page, watch it (Keep's watch, action watch), and do the work it asks for.`,
    above.length ? `Where it sits in Keep: ${above.join(" › ")} › ${info?.title ?? ""}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The turn a thread gets: what happened, where, and the ids it needs to answer. */
export function render(n: Notification) {
  const self = config.peopleId && n.actor === `people:person/${config.peopleId}`;
  const page = pageOf(n);
  const d = n.data ?? ({} as Notification["data"]);
  return [
    `[keep · ${n.type}] ${n.title}`,
    n.text?.trim() ?? "",
    `Page: ${page}${d.workspace ? ` (workspace ${d.workspace})` : ""}`,
    n.actor ? `By: ${n.actor}${self ? " (you, from another pai thread)" : ""}` : "",
    d.comment ? `Comment: ${d.comment} — react 👀 on it (comment, action react), answer with comment action add, reply_to ${d.comment}` : "",
    d.mention ? `Mentioned in: ${d.mention}${d.property ? ` (${d.property})` : ""}` : "",
    d.role ? `Role: ${d.role}` : "",
    d.changes?.length ? `Changes:\n${d.changes.map((c) => `- ${c.kind}${c.name ? ` ${c.name}` : ""}: ${c.summary}`).join("\n")}` : "",
    d.since ? `The diff: read_page id ${pageId(page)} with since "${d.since}"` : "",
    n.url,
    `(notification ${n.id})`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Hands the notification to its target; a thread that cannot be revived hands it to pai. Where it went. */
function deliver(target: Target, n: Notification): Target {
  const text = render(n);
  if (target.kind === "agent") {
    agents.message(target.slug, text, { from: "keep", kind: "chat", meta: { notification: n.id } });
    return target;
  }
  if (target.kind === "thread") {
    const s = sessions.ensureLive(target.sessionId);
    if (s) {
      s.send(text, { origin: "system" });
      return target;
    }
  }
  main.system(text);
  return { kind: "main" };
}
