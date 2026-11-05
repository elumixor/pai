import { config } from "../core/config.ts";
import { logger } from "../core/log.ts";
import type { KeepPage, PropertyDef } from "./dev-tasks.ts";
import { callKeep, KeepError, pageId } from "./keep.ts";
import * as people from "./people.ts";

/**
 * An agent's Keep page: the task it works from and is tracked on. Its body is the brief, its Assignee the agent's
 * person, its Status follows the agent. Written under the agent's own thread tag, so its watch does not wake it for
 * what the daemon wrote on its behalf.
 */

const log = logger("agent-page");

const ASSIGNEE: PropertyDef = { name: "Assignee", type: "person" };
const STATUS_PROPERTY = /^status$/i;
const GENERAL_TITLE = "General";

/** The option names a status means, best first; a workspace without any of them is left as it is. */
const STATUS_OPTIONS = {
  working: ["In progress", "Doing"],
  waiting: ["Waiting on me", "Waiting on others", "In progress", "Doing"],
  done: ["In review", "Done"],
  closed: ["Done"],
  dropped: ["Dropped", "Done"],
} as const;
export type PageStatus = keyof typeof STATUS_OPTIONS;

const tagged = (sessionId: string | null) => (sessionId ? { client: `pai:thread/${sessionId}` } : {});

/** The page behind a URN or id; throws what Keep said when it cannot be read. */
export const read = (page: string) => callKeep<KeepPage>("read_page", { id: pageId(page) });

const url = (p: KeepPage) => `${config.keepUrl.replace(/\/$/, "")}/p/${p.id}`;

/** What the client shows of a page. */
export async function shown(urn: string) {
  const p = await read(urn);
  return { urn, id: p.id, title: p.title, path: p.path ?? [], body: p.body ?? "", properties: p.properties ?? {}, url: url(p) };
}

/** Assignee = this person, on the page's person property, defining one when the page has none. */
export async function assign(urn: string, assignee: string, sessionId: string | null) {
  const p = await read(urn);
  const defs = p.schema ?? [];
  const target = defs.find((d) => d.type === "person");
  await callKeep("edit_page", { id: p.id, properties: { [target?.name ?? ASSIGNEE.name]: [assignee] }, ...(target ? {} : { define: [ASSIGNEE] }) }, tagged(sessionId));
}

/** A thread's watch on the page, so its comments and changes come to the agent. */
export const watch = (urn: string, sessionId: string) => callKeep("watch", { action: "watch", page_id: pageId(urn) }, tagged(sessionId));

/** The page's Status to what the agent is doing now, when the workspace has such an option. Never throws. */
export async function followStatus(urn: string, status: PageStatus, sessionId: string | null) {
  try {
    const p = await read(urn);
    const property = (p.schema ?? []).find((d) => d.type === "select" && STATUS_PROPERTY.test(d.name));
    const option = STATUS_OPTIONS[status].map((name) => property?.options?.find((o) => o.name.toLowerCase() === name.toLowerCase())).find(Boolean);
    if (!property || !option) return;
    await callKeep("edit_page", { id: p.id, properties: { [property.name]: option.name } }, tagged(sessionId));
  } catch (err) {
    log.warn(`status of ${urn}: ${(err as Error).message}`);
  }
}

export interface Workspace {
  readonly id: string;
  readonly title: string;
  readonly icon: string | null;
  readonly role: string;
}

/** The workspaces Pai's key reaches. */
export async function workspaces() {
  const { workspaces: own, shared } = await callKeep<{ workspaces: readonly Workspace[]; shared: readonly Workspace[] }>("list_workspaces", {});
  return { workspaces: own.map((w) => ({ ...w, url: `${config.keepUrl.replace(/\/$/, "")}/p/${w.id}` })), shared };
}

interface Trait {
  readonly name: string;
  readonly properties: readonly PropertyDef[];
}

/** General's own page in the home workspace, found or made; assigned to the Pai group, so to General. */
export async function ensureGeneral(): Promise<string> {
  const { workspaces: own } = await workspaces();
  const home = own.find((w) => w.title === config.keepHome);
  if (!home) throw new KeepError(`no Keep workspace named ${config.keepHome}`);
  const found = await callKeep<{ pages: readonly { id: string }[] }>("find_pages", { workspace_id: home.id, filter: [{ property: "$title", op: "is", value: GENERAL_TITLE }], limit: 1 });
  if (found.pages[0]) return `keep:page/${found.pages[0].id}`;
  const traits = await callKeep<readonly Trait[]>("list_workspace_traits", { workspace_id: home.id });
  const task = traits.find((t) => t.name === "Task");
  const made = await callKeep<{ id: string }>("create_page", {
    parent_id: home.id,
    title: GENERAL_TITLE,
    body: "The tracker of General, pai's top agent: the one point of contact for everything the user wants done. Each job it hands off has a page of its own, assigned to the worker doing it.",
    ...(task ? { traits: [task.name], properties: { Assignee: people.groupUrn(), Status: "In progress" } } : {}),
  });
  return `keep:page/${made.id}`;
}
