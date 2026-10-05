import { db, now } from "../core/db.ts";
import { logger } from "../core/log.ts";
import * as agents from "./agents.ts";
import * as messages from "./messages.ts";

const log = logger("requests");

/**
 * Agents never address each other: an agent names what it needs ("review in the user's voice",
 * "is this person already a candidate?") and pai decides who does it. The first time a need
 * comes up pai routes it with a model turn and the route is remembered; after that the same
 * need is forwarded by code, so a routine review costs only the reviewer's turn. Every hop is a
 * row in the message log.
 */

export interface Request {
  readonly id: number;
  readonly requester: string;
  readonly need: string;
  readonly payload: string;
  readonly replyToMe: boolean;
  readonly handler: string | null;
  readonly status: "open" | "forwarded" | "answered" | "failed";
  readonly response: string | null;
  readonly createdAt: number;
  readonly answeredAt: number | null;
}

const toRequest = (r: Record<string, any>): Request => ({
  id: r.id,
  requester: r.requester,
  need: r.need,
  payload: r.payload,
  replyToMe: Boolean(r.reply_to_me),
  handler: r.handler ?? null,
  status: r.status,
  response: r.response ?? null,
  createdAt: r.created_at,
  answeredAt: r.answered_at ?? null,
});

export class RequestError extends Error {}

/** A need as a route key: case and spacing do not make two needs. */
export const needKey = (need: string) => need.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export function get(id: number): Request | undefined {
  const row = db.query("SELECT * FROM requests WHERE id = ?").get(id) as Record<string, any> | undefined;
  return row ? toRequest(row) : undefined;
}

export function list(opts: { status?: Request["status"]; limit?: number } = {}): Request[] {
  const rows = opts.status
    ? db.query("SELECT * FROM requests WHERE status = ? ORDER BY id DESC LIMIT ?").all(opts.status, opts.limit ?? 50)
    : db.query("SELECT * FROM requests ORDER BY id DESC LIMIT ?").all(opts.limit ?? 50);
  return (rows as Record<string, any>[]).map(toRequest);
}

export function routes(): { need: string; agent: string; uses: number }[] {
  return db.query("SELECT need, agent, uses FROM routes ORDER BY need").all() as { need: string; agent: string; uses: number }[];
}

export const forgetRoute = (need: string) => db.prepare("DELETE FROM routes WHERE need = ?").run(needKey(need)).changes > 0;

function routeFor(need: string): string | undefined {
  const row = db.query("SELECT agent FROM routes WHERE need = ?").get(needKey(need)) as { agent: string } | undefined;
  if (!row) return undefined;
  const a = agents.get(row.agent);
  // A route to an agent that closed is stale; pai decides again.
  if (!a || a.status === "closed") {
    forgetRoute(need);
    return undefined;
  }
  return row.agent;
}

/** How pai gets a turn for a request it has to route itself; main.ts registers it. */
let toPai: (text: string) => void = () => {};
/** A turn whose words stay out of the user's chat: routing is housekeeping. */
let routePai: (text: string) => void = () => {};
export function linkPai(turn: (text: string) => void, silent: (text: string) => void = turn) {
  toPai = turn;
  routePai = silent;
}

/** An agent's need. Routed by code when the need has a route, by pai otherwise. */
export function create(requester: string, need: string, payload: string, replyToMe = true): Request {
  if (!need.trim()) throw new RequestError("name the need, e.g. 'review in the user's voice'");
  const res = db.prepare("INSERT INTO requests (requester, need, payload, reply_to_me, created_at) VALUES (?, ?, ?, ?, ?)").run(requester, need.trim(), payload, replyToMe ? 1 : 0, now());
  const r = get(Number(res.lastInsertRowid))!;
  messages.log({ from: requester, to: agents.PAI, kind: "request", body: `${need.trim()}\n\n${payload}`.trim(), meta: { requestId: r.id, need: r.need } });
  const route = routeFor(need);
  if (route && route !== agents.PAI && route !== requester) {
    db.prepare("UPDATE routes SET uses = uses + 1 WHERE need = ?").run(needKey(need));
    forward(r.id, route, false);
  } else {
    routePai(
      `[request #${r.id} from ${agents.breadcrumb(requester)}] need: ${r.need}\n\n${payload}\n\nRoute it with forward_request (the route is remembered, so the same need skips you next time), or answer it yourself with respond_request. Anything that ends in a message sent as the user passes your outbound check first; if the user has to approve it, use ask_user. Nothing you say in this turn reaches the user.`,
    );
  }
  return get(r.id)!;
}

/** Hands a request to an agent; its turn's text comes back as the response. */
export function forward(id: number, agent: string, remember = true): Request {
  const r = get(id);
  if (!r) throw new RequestError(`no request #${id}`);
  if (r.status === "answered") throw new RequestError(`request #${id} is already answered`);
  const a = agents.get(agent);
  if (!a || a.status === "closed") throw new RequestError(`no agent ${agent}`);
  if (agent === r.requester) throw new RequestError("a request does not go back to whoever asked");
  if (agent === agents.PAI) throw new RequestError("answer it yourself with respond_request");
  db.prepare("UPDATE requests SET status = 'forwarded', handler = ? WHERE id = ?").run(agent, id);
  if (remember) db.prepare("INSERT OR REPLACE INTO routes (need, agent, uses, created_at) VALUES (?, ?, COALESCE((SELECT uses FROM routes WHERE need = ?), 0), ?)").run(needKey(r.need), agent, needKey(r.need), now());
  agents.message(agent, `[request #${id} from ${agents.breadcrumb(r.requester)}, via pai] ${r.need}\n\n${r.payload}\n\nYour reply in this turn is the answer: say only what goes back.`, { from: agents.PAI, kind: "request", requestId: id });
  log.info(`#${id} ${r.need} → ${agent}${remember ? " (route kept)" : ""}`);
  return get(id)!;
}

/** The answer to a request goes back to whoever asked: a turn when they wait for it, a note otherwise. */
export function respond(id: number, text: string, by: string = agents.PAI): Request {
  const r = get(id);
  if (!r) throw new RequestError(`no request #${id}`);
  if (r.status === "answered") return r;
  db.prepare("UPDATE requests SET status = 'answered', response = ?, handler = COALESCE(handler, ?), answered_at = ? WHERE id = ?").run(text, by, now(), id);
  messages.log({ from: by, to: r.requester, kind: "response", body: text, meta: { requestId: id, need: r.need } });
  const reply = `[response to your request #${id} "${r.need}" from ${agents.breadcrumb(by)}]\n${text}`;
  if (r.requester === agents.PAI) toPai(reply);
  else if (r.replyToMe) agents.message(r.requester, reply, { from: by, kind: "response", logged: true });
  else agents.noteTo(r.requester, reply);
  return get(id)!;
}

/** A turn that was answering a request is its response; called once at start, after the modules have loaded. */
export function wire() {
  agents.onRequestAnswered((id, by, text) => {
    try {
      respond(id, text || "(no answer)", by);
    } catch (err) {
      log.warn(`#${id}: ${(err as Error).message}`);
    }
  });
}
