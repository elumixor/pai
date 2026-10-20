import { discardDraft, editDraft, sendDraft } from "./api.ts";
import { el } from "./dom.ts";
import { icon } from "./icons.ts";
import { markdown } from "./markdown.ts";

/**
 * A draft as the thing it will become: an email with its to, cc and subject; a Telegram or WhatsApp
 * message with its recipient; a post with just its words — editable in place, with Send and Discard
 * on the card.
 *
 * **The card is the approval.** What goes out is what it holds when he presses Send, so the fields
 * he has typed into travel with that press rather than relying on a save having landed first. The
 * send itself goes back to the agent that offered it, through its own channel tool, so the
 * read-back verification stays where it is — and its answer (`verified`, `unverified`, `not_sent`)
 * comes back onto this card.
 */

export interface Draft {
  readonly id: number;
  readonly channel: "email" | "telegram" | "whatsapp" | "linkedin" | "post";
  readonly fields: { readonly to?: string; readonly cc?: string; readonly subject?: string; readonly body: string; readonly account?: string };
  readonly status: "pending" | "sending" | "sent" | "failed" | "dropped";
  readonly state?: "verified" | "unverified" | "not_sent" | null;
  readonly note?: string;
  readonly from?: string;
}

/** What each channel really has, and what to call it on the card. */
const SHAPE: Record<Draft["channel"], readonly { readonly key: "account" | "to" | "cc" | "subject"; readonly label: string }[]> = {
  email: [
    { key: "account", label: "From" },
    { key: "to", label: "To" },
    { key: "cc", label: "Cc" },
    { key: "subject", label: "Subject" },
  ],
  telegram: [{ key: "to", label: "To" }],
  whatsapp: [{ key: "to", label: "To" }],
  linkedin: [{ key: "to", label: "To" }],
  post: [],
};
const WHAT: Record<Draft["channel"], string> = { email: "Email", telegram: "Telegram", whatsapp: "WhatsApp", linkedin: "LinkedIn message", post: "LinkedIn post" };
/** What the three answers mean, in his words rather than the tool's. */
const SAID: Record<string, string> = {
  verified: "sent — read back where it went",
  unverified: "taken, but it could not be read back: it may already have arrived, so it was not sent again",
  not_sent: "nothing left — it is safe to try again",
};

export interface DraftCardContext {
  /** Something changed on the daemon's side: the host reloads what waits. */
  readonly changed?: () => void;
}

export function draftCard(draft: Draft, ctx: DraftCardContext = {}) {
  const editable = draft.status === "pending";
  const inputs = new Map<string, HTMLInputElement | HTMLTextAreaElement>();

  const field = (key: "account" | "to" | "cc" | "subject", label: string) => {
    const value = draft.fields[key] ?? "";
    if (!editable && !value) return undefined;
    const input = el("input.draft-input", { value, placeholder: label, disabled: editable ? undefined : "true" }) as HTMLInputElement;
    inputs.set(key, input);
    return el("label.draft-field", {}, el("span.draft-label", {}, label), input);
  };

  const body = editable
    ? (el("textarea.draft-body", { rows: "8" }, draft.fields.body) as HTMLTextAreaElement)
    : el("div.draft-read", {}, markdown(draft.fields.body));
  if (editable) inputs.set("body", body as HTMLTextAreaElement);

  const note = el("span.draft-note");
  const busy = (on: boolean) => {
    for (const input of inputs.values()) input.disabled = on;
    for (const button of card.querySelectorAll<HTMLButtonElement>(".draft-act")) button.disabled = on;
  };

  /** Everything the card holds now — this is what Send sends. */
  const held = () => Object.fromEntries([...inputs].map(([key, input]) => [key, input.value]));

  const send = async () => {
    busy(true);
    note.textContent = "sending…";
    const result = await sendDraft(draft.id, held());
    if (result.error) {
      note.textContent = result.error;
      busy(false);
      return;
    }
    note.textContent = "with its agent now";
    ctx.changed?.();
  };

  const discard = async () => {
    busy(true);
    const result = await discardDraft(draft.id);
    if (result.error) {
      note.textContent = result.error;
      busy(false);
      return;
    }
    ctx.changed?.();
  };

  /** A keystroke is kept, so a draft he edited and left survives a reload of the page. */
  let saving: ReturnType<typeof setTimeout> | undefined;
  const keep = () => {
    if (!editable) return;
    if (saving) clearTimeout(saving);
    saving = setTimeout(() => void editDraft(draft.id, held()).catch(() => undefined), 600);
  };
  for (const input of inputs.values()) input.addEventListener("input", keep);

  const head = el(
    "div.draft-head",
    {},
    icon("send", 12),
    el("b", {}, WHAT[draft.channel]),
    draft.from ? el("span.draft-who", {}, draft.from) : undefined,
    el("span.draft-id", {}, `#${draft.id}`),
  );

  const foot =
    draft.status === "pending"
      ? el(
          "div.draft-foot",
          {},
          el("button.opt.draft-act.draft-send", { onclick: () => void send() }, "Send"),
          el("button.opt.draft-act.faint", { onclick: () => void discard() }, "Discard"),
          note,
        )
      : el("div.draft-foot", {}, el("span.draft-state", { class: `draft-state ${draft.state ?? draft.status}` }, draft.state ? SAID[draft.state] : draft.status === "sending" ? "with its agent now" : draft.status), draft.note ? el("span.draft-note", {}, draft.note) : undefined);

  const card = el(
    "div.row.draft-card",
    { class: `row draft-card ${draft.status}`, "data-draft": draft.id },
    head,
    ...SHAPE[draft.channel].map((f) => field(f.key, f.label)).filter(Boolean),
    body,
    foot,
  );
  return card;
}
