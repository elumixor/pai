import { bus, type PaiEvent } from "../core/bus.ts";
import { config } from "../core/config.ts";
import { db, now } from "../core/db.ts";
import { logger } from "../core/log.ts";
import * as dev from "./dev.ts";
import { callKeep, pageId } from "./keep.ts";
import * as messages from "./messages.ts";

/**
 * Keep → dev: a Keep task whose effective properties carry a dev `project` (its own or inherited from the project
 * page above it) and no dev `session` gets one Claude Code session from dev, started with a brief made of the task
 * (title, body, the titles above it). The session's `dev:session/<id>` is written back onto the task, and the task's
 * status follows the session: In progress while a turn runs, In review when it stops. One session per task, ever:
 * the task's URN is claimed in `dev_tasks` before dev is asked. Off with `PAI_DEV_TASKS=0`.
 */

const log = logger("dev-tasks");
const SYNC_MS = 60 * 1000;
/** A claim whose start never finished (a restart mid-call) may be taken again after this. */
const STALE_CLAIM_MS = 5 * 60 * 1000;
/** Sessions older than this are no longer followed. */
const FOLLOW_MS = 14 * 24 * 60 * 60 * 1000;

export const PROJECT_PREFIX = "dev:project/";
export const SESSION_PREFIX = "dev:session/";

export interface PropertyDef {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly extension?: string;
  readonly extType?: string;
  readonly options?: readonly { id: string; name: string }[];
}

export interface KeepPage {
  readonly id: string;
  readonly urn?: string;
  readonly title: string;
  readonly kind?: string;
  readonly path?: readonly string[];
  readonly body?: string;
  readonly properties?: Record<string, unknown>;
  readonly effective?: Record<string, unknown>;
  readonly schema?: readonly PropertyDef[] | null;
}

interface Found {
  readonly key: string;
  readonly urn: string;
  /** The extension value itself (`{ urn, label, fields }`). */
  readonly value: Record<string, unknown>;
}

/** The first `{urn}` under a property value (an extension value, an array of them, or one wrapped with `inheritedFrom`). */
function urnIn(value: unknown, prefix: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = urnIn(item, prefix);
      if (found) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.urn === "string" && record.urn.startsWith(prefix)) return record;
  return urnIn(record.value, prefix);
}

/** The property holding a value of this kind (`dev:project/…`, `dev:session/…`). */
export function findValue(values: Record<string, unknown> | undefined, prefix: string): Found | undefined {
  for (const [key, value] of Object.entries(values ?? {})) {
    const found = urnIn(value, prefix);
    if (found) return { key, urn: String(found.urn), value: found };
  }
  return undefined;
}

/** Where the session goes: an extension property of type `session`, the project property's extension preferred. */
export function sessionProperty(schema: readonly PropertyDef[] | null | undefined, projectKey?: string) {
  const sessions = (schema ?? []).filter((p) => p.type === "extension" && p.extType === "session");
  const extension = schema?.find((p) => p.id === projectKey)?.extension;
  return sessions.find((p) => p.extension === extension) ?? sessions[0];
}

export type Status = "doing" | "review";
const STATUS_NAMES: Record<Status, string> = { doing: "in progress", review: "in review" };

/** The status select and the option for this state; undefined when the database has no such option. */
export function statusOption(schema: readonly PropertyDef[] | null | undefined, status: Status) {
  const selects = (schema ?? []).filter((p) => p.type === "select");
  const ordered = [...selects.filter((p) => /status/i.test(p.name)), ...selects.filter((p) => !/status/i.test(p.name))];
  for (const property of ordered) {
    const option = property.options?.find((o) => o.name.trim().toLowerCase() === STATUS_NAMES[status]);
    if (option) return { property: property.id, option: option.id };
  }
  return undefined;
}

/** What the session is told: the task, its body, and where it sits. */
export function brief(page: KeepPage, urn: string) {
  const above = (page.path ?? []).filter(Boolean);
  return [
    `# ${page.title}`,
    page.body?.trim() || "",
    above.length ? `Where this task sits in Keep: ${above.join(" › ")} › ${page.title}` : "",
    `Keep task: ${urn}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

const slugOf = (projectUrn: string) => projectUrn.slice(PROJECT_PREFIX.length);
const effectiveOf = (page: KeepPage) => page.effective ?? page.properties;

/** Takes the task; false when it is someone else's already (a session started, or a start in flight). */
function claim(urn: string, workspace: string, project: string, title: string) {
  const at = now();
  const res = db
    .prepare(
      `INSERT INTO dev_tasks (keep_urn, workspace, project, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(keep_urn) DO UPDATE SET project = excluded.project, title = excluded.title, created_at = excluded.created_at, updated_at = excluded.updated_at
       WHERE dev_tasks.session_id IS NULL AND dev_tasks.created_at < ?`,
    )
    .run(urn, workspace, project, title, at, at, at - STALE_CLAIM_MS);
  return res.changes > 0;
}

const release = (urn: string) => db.prepare("DELETE FROM dev_tasks WHERE keep_urn = ? AND session_id IS NULL").run(urn);

async function readPage(workspace: string, urn: string) {
  return callKeep<KeepPage>(workspace, "get_page", { id: pageId(urn) });
}

/** One Keep page event: starts the task's session when it should have one. Answers what it did, for tests and logs. */
export async function consider(event: { urn: string; workspace: string; effective?: Record<string, unknown> }) {
  // The webhook already says the page has no dev project: nothing to read.
  if (event.effective && !findValue(event.effective, PROJECT_PREFIX)) return "no project";
  if (db.query("SELECT 1 FROM dev_tasks WHERE keep_urn = ? AND session_id IS NOT NULL").get(event.urn)) return "has session";
  const page = await readPage(event.workspace, event.urn);
  // A database's schema is its rows', so it would look like a task holding a session property.
  if (page.kind === "database") return "database";
  const values = effectiveOf(page);
  const project = findValue(values, PROJECT_PREFIX);
  if (!project) return "no project";
  if (findValue(values, SESSION_PREFIX)) return "has session";
  // Only a row of a database with a session property is a task; a project page has nowhere to hold one.
  const target = sessionProperty(page.schema, project.key);
  if (!target) return "no session property";
  const slug = slugOf(project.urn);
  if (!claim(event.urn, event.workspace, slug, page.title)) return "claimed";
  let started: dev.StartedSession;
  try {
    // The whole value, so dev reads the project's own fields (worktree per task).
    started = await dev.startSession({ project: { urn: project.urn, fields: project.value.fields }, keepUrn: event.urn, title: page.title, brief: brief(page, event.urn) });
  } catch (err) {
    release(event.urn);
    throw err;
  }
  db.prepare("UPDATE dev_tasks SET session_id = ?, updated_at = ? WHERE keep_urn = ?").run(started.id, now(), event.urn);
  const value = [{ urn: started.urn, label: `${slug} · ${started.id.slice(0, 6)}` }];
  const doing = statusOption(page.schema, "doing");
  await callKeep(event.workspace, "set_properties", {
    id: page.id,
    properties: { [target.id]: value, ...(doing ? { [doing.property]: doing.option } : {}) },
  });
  if (doing) db.prepare("UPDATE dev_tasks SET status = 'doing' WHERE keep_urn = ?").run(event.urn);
  messages.event("pai", "dev.session", `Started a dev session for ${page.title} in ${slug}`, {
    meta: { link: started.url ?? event.urn, keep: event.urn, session: started.urn },
  });
  log.info(`${event.urn}: session ${started.id.slice(0, 6)} in ${slug}`);
  return "started";
}

/** Each followed session's state onto its task's status, written only when it changed. */
export async function sync() {
  const rows = db
    .query("SELECT keep_urn, workspace, session_id, status FROM dev_tasks WHERE session_id IS NOT NULL AND created_at > ?")
    .all(now() - FOLLOW_MS) as { keep_urn: string; workspace: string; session_id: string; status: string | null }[];
  for (const row of rows) {
    try {
      const busy = await dev.sessionBusy(row.session_id);
      if (busy === undefined) continue;
      const status: Status = busy ? "doing" : "review";
      if (status === row.status) continue;
      const page = await readPage(row.workspace, row.keep_urn);
      const option = statusOption(page.schema, status);
      if (option) await callKeep(row.workspace, "set_properties", { id: page.id, properties: { [option.property]: option.option } });
      db.prepare("UPDATE dev_tasks SET status = ?, updated_at = ? WHERE keep_urn = ?").run(status, now(), row.keep_urn);
    } catch (err) {
      log.warn(`sync ${row.keep_urn}: ${(err as Error).message}`);
    }
  }
}

/** Follows Keep's page events and the sessions' states; a no-op with `PAI_DEV_TASKS=0`. */
export function start() {
  if (!config.devTasks) return () => {};
  // One event at a time: a webhook and its retry arriving together must not both read "no session".
  let queue = Promise.resolve();
  const onEvent = (event: PaiEvent) => {
    if (event.kind !== "keep.page.created" && event.kind !== "keep.page.changed") return;
    const payload = event.payload as { urn: string; workspace: string; effective?: Record<string, unknown> };
    queue = queue.then(() =>
      consider(payload).then(
        (outcome) => log.debug(`${payload.urn}: ${outcome}`),
        (err: Error) => log.warn(`${payload.urn}: ${err.message}`),
      ),
    );
  };
  bus.on("event", onEvent);
  const timer = setInterval(() => void sync(), SYNC_MS);
  return () => {
    bus.off("event", onEvent);
    clearInterval(timer);
  };
}
