import { z } from "zod";
import * as credits from "./credits.ts";

/**
 * The message the user means, from the draft he typed: in the language the conversation is held in, in the
 * way he writes to this person, with every fact of the draft and nothing added. Paigram sends the chat around
 * the draft; when the draft leaves a decision open the answer asks first.
 */

export type ChatKind = "telegram" | "email" | "whatsapp";

export interface ChatLine {
  readonly fromMe: boolean;
  readonly author: string;
  readonly text: string;
  /** Epoch seconds. */
  readonly at: number;
}

export interface ComposeRequest {
  readonly kind: ChatKind;
  readonly chatTitle: string;
  readonly subject?: string;
  readonly draft: string;
  readonly messages: readonly ChatLine[];
  readonly answers?: readonly { readonly question: string; readonly answer: string }[];
  /** The language questions and notes are written in: his app's, not the chat's. */
  readonly askIn?: string;
  /** The phone's clock (epoch seconds) and time zone, so "tomorrow" and "at 5" mean his tomorrow and his 5. */
  readonly now?: number;
  readonly timeZone?: string;
}

const Composed = z.object({
  text: z.string().describe("the message to send, ready as it is"),
  questions: z.array(z.object({ question: z.string(), options: z.array(z.string()) })).describe("decisions only he can make, in the language he is talked to in; usually empty"),
  notes: z.array(z.string()).describe("one-line heads-ups that need no decision, in the language he is talked to in; usually empty"),
});

export type ComposeResult = z.infer<typeof Composed>;

/** Lines of the conversation the model reads, newest kept; a long email is cut, its opening is what matters. */
const MAX_LINES = 40;
const MAX_LINE_CHARS = 1_500;
const MAX_TOKENS = 4_000;
const DEFAULT_ASK_IN = "English";

const SYSTEM = `You write the message the user will send in this conversation, from what he typed in the message field.

What he typed is one of two things; tell them apart from its wording and the conversation:
- A draft of the message itself (possibly in another language, shorthand or a mix): rewrite it as he would send it.
- An instruction to you about the message ("say I agree", "decline politely", "ask when it's ready", "answer his question", "translate", "remind her about Friday", "напиши что опоздаю", "reply in Czech"): carry it out and write the message that does what he asks. Never echo the instruction itself, never answer him instead of the other person. An explicit target language in the instruction wins over the conversation's.
When it could be either, treat it as a draft.

Dates and times: the current moment and his time zone are given; the conversation is stamped in his time zone with weekdays. Read "today", "tomorrow", "on Friday", "next week", "in an hour" against now, and against the stamp of the message being answered when he answers it ("yes, that works" answers the latest proposal). When the message names a day or a time, write it so the other person cannot misread it (the weekday, and the date when it is more than a few days away), in the form his own messages use. Never move a date or time he gave. Mention his time zone only when the other person is clearly in another one and the time matters.

Context: before writing, work out from the conversation who the other person is to him, what they last said or asked, what is still open between them, and what was already agreed (places, times, amounts, names). Use it to resolve references and to answer what was asked; do not repeat what is settled.

Language: the language the conversation is held in, judged from its latest messages on both sides. The draft may be in another language, in shorthand, or a mix: translate it. With no conversation yet, use the draft's language. Never mix languages in one message.

Voice: write the way he writes here. His own messages are marked "me": match their length, formality (ты/вы, tu/vous, Sie/du), greetings, punctuation, capitalisation, emoji and whether he splits thoughts into short lines. With few of his messages to go on, be natural, concise and warm.

Content: keep every fact, number, date, name and intention of the draft (or of the instruction), and add none (no new promises, details, apologies or pleasantries beyond his habit). Turn shorthand into whole natural sentences. Resolve a reference ("that", "it") from the conversation only when it is unambiguous.

Email: the text is the whole body, with the greeting and sign-off he uses with this person; no subject line.

Questions: ask only when a correct message needs his decision: the draft is ambiguous in a way that changes its meaning, contradicts what was agreed (another date, time or amount), leaves out an answer the other person explicitly asked for, or could land as rude. Each question short, with two to four concrete options. Still give your best text.

Questions, options and notes are read by him, not sent: write them in the language named under "Talk to him in", whatever the message's language.

Notes: a heads-up that needs no decision, one line each; usually none.`;

/** A time zone the runtime knows, else UTC. */
const zoneOf = (zone: string | undefined) => {
  try {
    if (zone) new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return zone ?? "UTC";
  } catch {
    return "UTC";
  }
};

/** "Mon 2026-11-02 21:08", in his time zone. */
function stamper(zone: string) {
  const format = new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return (at: number) => {
    const part = Object.fromEntries(format.formatToParts(new Date(at * 1000)).map((p) => [p.type, p.value]));
    return `${part.weekday} ${part.year}-${part.month}-${part.day} ${part.hour}:${part.minute}`;
  };
}

function prompt(request: ComposeRequest): string {
  const zone = zoneOf(request.timeZone);
  const stamp = stamper(zone);
  const now = request.now ?? Math.floor(Date.now() / 1000);
  const lines = request.messages.slice(-MAX_LINES).map((m) => `[${stamp(m.at)}] ${m.fromMe ? "me" : m.author}: ${m.text.slice(0, MAX_LINE_CHARS)}`);
  const answers = request.answers?.length ? `\n\nHis answers to your questions:\n${request.answers.map((a) => `- ${a.question} → ${a.answer}`).join("\n")}` : "";
  return [
    `Now: ${stamp(now)} (${zone})`,
    `Chat: ${request.chatTitle} (${request.kind}${request.subject ? `, subject "${request.subject}"` : ""})`,
    `Conversation, oldest first:\n${lines.length ? lines.join("\n") : "(none yet)"}`,
    `What he typed:\n${request.draft}${answers}`,
    `Talk to him in: ${request.askIn ?? DEFAULT_ASK_IN}`,
  ].join("\n\n");
}

export const compose = (request: ComposeRequest): Promise<ComposeResult> => credits.structured("sonnet", SYSTEM, prompt(request), Composed, MAX_TOKENS, "compose");
