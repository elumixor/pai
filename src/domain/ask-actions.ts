/**
 * What a button on an ask can do besides answering in words: open a place and come back. A card an agent asks with a
 * known flow is checked here by the daemon, so it closes when the thing really happened, not when someone said so.
 */
import { config } from "../core/config.ts";
import { logger } from "../core/log.ts";
import * as connectors from "../connectors/loader.ts";
import * as agentPage from "./agent-page.ts";
import * as asks from "./asks.ts";

const log = logger("ask-actions");

/** What an agent may ask for. `run` actions are the daemon's own and never come from a model. */
export interface ActionRequest {
  readonly kind: "link" | "connect_workspaces" | "connect_connector";
  readonly label?: string;
  readonly url?: string;
  readonly connector?: string;
}

export class ActionError extends Error {}

const base = () => config.baseUrl.replace(/\/$/, "");

const ownWorkspaces = async () => (await agentPage.workspaces()).workspaces.map((w) => ({ id: w.id, title: w.title }));

/** Keep's page for giving someone access, which comes back here. Keep knows a person, not Pai. */
export function connectUrl() {
  const url = new URL("/connect", config.keepUrl);
  url.searchParams.set("person", config.peopleId);
  url.searchParams.set("next", base());
  return url.href;
}

/** Turns what the tool was given into card actions. A link must be http(s): a model cannot put a script behind a button. */
export async function resolve(requests: readonly ActionRequest[]): Promise<readonly asks.AskAction[]> {
  return Promise.all(
    requests.map(async (r): Promise<asks.AskAction> => {
      if (r.kind === "connect_workspaces") return { kind: "link", label: r.label ?? "Connect workspaces", url: connectUrl(), verify: "keep_workspaces", baseline: await ownWorkspaces() };
      if (r.kind === "connect_connector") {
        if (!r.connector || !connectors.available().includes(r.connector)) throw new ActionError(`no connector ${r.connector}`);
        return { kind: "link", label: r.label ?? `Connect ${r.connector}`, url: `${base()}/#/settings/connectors`, verify: `connector:${r.connector}` };
      }
      if (!r.url || !/^https?:\/\//.test(r.url)) throw new ActionError("a link action needs an http(s) url");
      return { kind: "link", label: r.label ?? new URL(r.url).host, url: r.url };
    }),
  );
}

async function settled(action: asks.AskAction) {
  if (action.verify === "keep_workspaces") {
    const now = await ownWorkspaces();
    const baseline = action.baseline ?? [];
    const added = now.filter((w) => !baseline.some((b) => b.id === w.id)).map((w) => w.title);
    const removed = baseline.filter((b) => !now.some((w) => w.id === b.id)).map((b) => b.title);
    return added.length || removed.length ? { added, removed } : undefined;
  }
  const name = action.verify?.startsWith("connector:") ? action.verify.slice("connector:".length) : undefined;
  if (!name) return undefined;
  const summary = (await connectors.connectors()).find((c) => c.name === name);
  return summary?.enabled && summary.status.state === "signed_in" ? { connector: name, state: "signed_in" } : undefined;
}

/** Each minute: a card waiting on something the daemon can see closes itself once it has happened. */
export async function verifyOpen() {
  for (const a of asks.open().filter((x) => x.actions.some((action) => action.verify))) {
    for (const action of a.actions.filter((x) => x.verify)) {
      try {
        const data = await settled(action);
        if (data) {
          asks.finish(a.id, { action: action.label, status: "verified", data });
          break;
        }
      } catch (err) {
        log.warn(`ask #${a.id}: ${(err as Error).message}`);
      }
    }
  }
}
