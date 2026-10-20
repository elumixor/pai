import { bus } from "../core/bus.ts";
import { db, now } from "../core/db.ts";
import { logger } from "../core/log.ts";
import * as messages from "./messages.ts";

/**
 * A draft is a card, and the card is the approval.
 *
 * Until now an outbound message was markdown in a chat row — `>` lines, To and Subject as bold
 * labels — and approving it meant typing "send", so changing one word meant copying the text out.
 * A draft is now a row of its own, shaped like the thing it will become, editable in place, with
 * Send and Discard on it.
 *
 * Two rules decide the whole design:
 *
 * 1. **What goes out is what the card holds when he presses Send**, never what the agent first
 *    wrote. So the fields live here, every edit lands here, and the send reads them at that moment.
 * 2. **The agent that offered it is the agent that sends it**, through its own channel tool — so the
 *    read-back verification (`verified` / `unverified` / `not_sent`, the thing the phantom LinkedIn
 *    sends taught us) stays exactly where it already is, and its answer comes back onto the card.
 */

const log = logger("drafts");

export type Channel = "email" | "telegram" | "whatsapp" | "linkedin" | "post";
export type DraftStatus = "pending" | "sending" | "sent" | "failed" | "dropped";
/** What the channel's own tool concluded, in its words: the card shows this and nothing softer. */
export type SendState = "verified" | "unverified" | "not_sent";

export interface Fields {
  /** email: the address; telegram/whatsapp: the peer; linkedin: the conversation. A post has none. */
  readonly to?: string;
  readonly cc?: string;
  readonly subject?: string;
  /** The words. Every channel has these. */
  readonly body: string;
  /** For email, which mailbox it leaves from. */
  readonly account?: string;
}

export interface Draft {
  readonly id: number;
  readonly agent: string;
  readonly channel: Channel;
  readonly fields: Fields;
  readonly status: DraftStatus;
  readonly state: SendState | null;
  readonly note: string;
  readonly taskId: number | null;
  readonly messageId: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Which fields a channel really has, so a card draws that channel and not a generic form. */
export const SHAPE: Readonly<Record<Channel, readonly (keyof Fields)[]>> = {
  email: ["account", "to", "cc", "subject", "body"],
  telegram: ["to", "body"],
  whatsapp: ["to", "body"],
  linkedin: ["to", "body"],
  post: ["body"],
};

/** The tool the owning agent must use, named in the wake so the send goes through its own path. */
const TOOL: Readonly<Record<Channel, string>> = {
  email: "gmail_send",
  telegram: "send_message",
  whatsapp: "whatsapp_send",
  linkedin: "linkedin_reply",
  post: "linkedin_post",
};

const LABEL: Readonly<Record<Channel, string>> = { email: "Email", telegram: "Telegram", whatsapp: "WhatsApp", linkedin: "LinkedIn message", post: "LinkedIn post" };

const toDraft = (r: Record<string, any>): Draft => ({
  id: r.id,
  agent: r.agent,
  channel: r.channel,
  fields: JSON.parse(r.fields || "{}") as Fields,
  status: r.status,
  state: r.state ?? null,
  note: r.note ?? "",
  taskId: r.task_id ?? null,
  messageId: r.message_id ?? null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class DraftError extends Error {}

export const get = (id: number): Draft | undefined => {
  const row = db.query("SELECT * FROM drafts WHERE id = ?").get(id) as Record<string, any> | undefined;
  return row ? toDraft(row) : undefined;
};

export const list = (opts: { status?: DraftStatus; agent?: string } = {}): Draft[] =>
  (db.query("SELECT * FROM drafts ORDER BY id DESC LIMIT 200").all() as Record<string, any>[])
    .map(toDraft)
    .filter((d) => (!opts.status || d.status === opts.status) && (!opts.agent || d.agent === opts.agent));

/** The drafts waiting on him: what the hand counts and the cards he has to answer. */
export const open = () => list({ status: "pending" }).concat(list({ status: "sending" })).sort((a, b) => a.id - b.id);

/** The plain-text form, for a client that cannot draw a card (Telegram, a terminal). */
export function asText(d: Draft): string {
  const f = d.fields;
  const head = [f.account ? `from: ${f.account}` : "", f.to ? `to: ${f.to}` : "", f.cc ? `cc: ${f.cc}` : "", f.subject ? `subject: ${f.subject}` : ""].filter(Boolean);
  const state = d.state ? `\n\n[${d.state}${d.note ? ` — ${d.note}` : ""}]` : d.status === "pending" ? "\n\n[a draft: approve it in the app, or say what to change]" : "";
  return `${LABEL[d.channel]} draft #${d.id}${head.length ? `\n${head.join("\n")}` : ""}\n\n${f.body}${state}`;
}

export interface OfferInput {
  readonly agent: string;
  readonly channel: Channel;
  readonly fields: Fields;
  readonly taskId?: number | null;
}

/**
 * An agent offers a draft. It becomes a row in the chat whose card he can edit, and the agent's
 * turn is over: the next move is his, and the send comes back to the agent later.
 */
export function offer(input: OfferInput): Draft {
  const body = input.fields.body?.trim();
  if (!body) throw new DraftError("a draft with no words is not a draft");
  if (!SHAPE[input.channel]) throw new DraftError(`no such channel: ${input.channel}`);
  for (const field of SHAPE[input.channel]) {
    if (field === "body" || field === "cc" || field === "account") continue;
    if (!input.fields[field]?.trim()) throw new DraftError(`a ${input.channel} draft needs ${field}`);
  }
  const at = now();
  const res = db
    .prepare("INSERT INTO drafts (agent, channel, fields, status, note, task_id, created_at, updated_at) VALUES (?, ?, ?, 'pending', '', ?, ?, ?)")
    .run(input.agent, input.channel, JSON.stringify({ ...input.fields, body }), input.taskId ?? null, at, at);
  const id = Number(res.lastInsertRowid);
  const draft = get(id)!;
  const row = messages.log({
    from: input.agent,
    to: "user",
    kind: "notice",
    body: asText(draft),
    taskId: input.taskId ?? null,
    meta: { draftId: id, draft: { channel: draft.channel, fields: draft.fields, status: draft.status, state: null, note: "" }, silent: false },
  });
  db.prepare("UPDATE drafts SET message_id = ? WHERE id = ?").run(row.id, id);
  log.info(`${input.agent} offered a ${input.channel} draft #${id}`);
  bus.emitEvent("draft.offered", { id, agent: input.agent, channel: input.channel });
  return get(id)!;
}

/** His edit. Only a draft that has not gone anywhere can change, and the row follows it. */
export function edit(id: number, fields: Partial<Fields>): Draft {
  const draft = get(id);
  if (!draft) throw new DraftError(`no draft #${id}`);
  if (draft.status !== "pending") throw new DraftError(`draft #${id} is ${draft.status}; it cannot be changed now`);
  const next: Fields = { ...draft.fields, ...fields, body: (fields.body ?? draft.fields.body).trim() };
  if (!next.body) throw new DraftError("a draft with no words is not a draft");
  db.prepare("UPDATE drafts SET fields = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(next), now(), id);
  const updated = get(id)!;
  touchRow(updated);
  bus.emitEvent("draft.changed", { id, channel: updated.channel });
  return updated;
}

/** The row in the chat says what the card says, so a client that only has the log is not lied to. */
function touchRow(d: Draft) {
  if (d.messageId === null) return;
  messages.update(d.messageId, {
    body: asText(d),
    meta: { draftId: d.id, draft: { channel: d.channel, fields: d.fields, status: d.status, state: d.state, note: d.note } },
  });
}

/** How the owning agent is told to send what the card holds *now*. */
export function wakeText(d: Draft): string {
  const f = d.fields;
  const lines = [
    `He approved draft #${d.id} (${LABEL[d.channel]}) and may have edited it. Send exactly what follows — not what you first wrote — with \`${TOOL[d.channel]}\`, then report the result with \`draft_result\`.`,
    "",
    ...(f.account ? [`from: ${f.account}`] : []),
    ...(f.to ? [`to: ${f.to}`] : []),
    ...(f.cc ? [`cc: ${f.cc}`] : []),
    ...(f.subject ? [`subject: ${f.subject}`] : []),
    "",
    f.body,
    "",
    `When it is done: draft_result(${d.id}, "<verified|unverified|not_sent>", "<what the tool said>"). \`unverified\` means it may already have arrived — never send it twice.`,
  ];
  return lines.join("\n");
}

/** His Send. The fields are read at this moment, and the agent is woken to send those. */
export function send(id: number): Draft {
  const draft = get(id);
  if (!draft) throw new DraftError(`no draft #${id}`);
  if (draft.status !== "pending") throw new DraftError(`draft #${id} is ${draft.status}`);
  db.prepare("UPDATE drafts SET status = 'sending', updated_at = ? WHERE id = ?").run(now(), id);
  const sending = get(id)!;
  touchRow(sending);
  bus.emitEvent("draft.sending", { id, agent: draft.agent, channel: draft.channel, text: wakeText(sending) });
  log.info(`he approved draft #${id}; ${draft.agent} is sending it`);
  return sending;
}

/** What the channel's own tool concluded, put back on the card. */
export function result(id: number, state: SendState, note = ""): Draft {
  const draft = get(id);
  if (!draft) throw new DraftError(`no draft #${id}`);
  db.prepare("UPDATE drafts SET status = ?, state = ?, note = ?, updated_at = ? WHERE id = ?").run(state === "not_sent" ? "failed" : "sent", state, note, now(), id);
  const settled = get(id)!;
  touchRow(settled);
  bus.emitEvent("draft.settled", { id, state, note });
  log.info(`draft #${id}: ${state}${note ? ` — ${note}` : ""}`);
  return settled;
}

/** His Discard. The agent hears it, so it does not sit waiting for an answer that will not come. */
export function discard(id: number, why = ""): Draft {
  const draft = get(id);
  if (!draft) throw new DraftError(`no draft #${id}`);
  if (draft.status === "sent" || draft.status === "sending") throw new DraftError(`draft #${id} is ${draft.status}; it is too late to discard it`);
  db.prepare("UPDATE drafts SET status = 'dropped', note = ?, updated_at = ? WHERE id = ?").run(why, now(), id);
  const dropped = get(id)!;
  touchRow(dropped);
  bus.emitEvent("draft.discarded", { id, agent: draft.agent, why });
  return dropped;
}

export const toolFor = (channel: Channel) => TOOL[channel];
export const labelFor = (channel: Channel) => LABEL[channel];
