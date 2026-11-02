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

const SYSTEM = `You turn the user's rough draft into the message he would actually send in this conversation.

Language: the language the conversation is held in, judged from its latest messages on both sides. The draft may be in another language, in shorthand, or a mix: translate it. With no conversation yet, use the draft's language. Never mix languages in one message.

Voice: write the way he writes here. His own messages are marked "me": match their length, formality (ты/вы, tu/vous, Sie/du), greetings, punctuation, capitalisation, emoji and whether he splits thoughts into short lines. With few of his messages to go on, be natural, concise and warm.

Content: keep every fact, number, date, name and intention of the draft, and add none (no new promises, details, apologies or pleasantries beyond his habit). Turn shorthand into whole natural sentences. Resolve a reference ("that", "it") from the conversation only when it is unambiguous.

Email: the text is the whole body, with the greeting and sign-off he uses with this person; no subject line.

Questions: ask only when a correct message needs his decision: the draft is ambiguous in a way that changes its meaning, contradicts what was agreed (another date, time or amount), leaves out an answer the other person explicitly asked for, or could land as rude. Each question short, with two to four concrete options. Still give your best text.

Questions, options and notes are read by him, not sent: write them in the language named under "Talk to him in", whatever the message's language.

Notes: a heads-up that needs no decision, one line each; usually none.`;

const stamp = (at: number) => new Date(at * 1000).toISOString().slice(0, 16).replace("T", " ");

function prompt(request: ComposeRequest): string {
  const lines = request.messages.slice(-MAX_LINES).map((m) => `[${stamp(m.at)}] ${m.fromMe ? "me" : m.author}: ${m.text.slice(0, MAX_LINE_CHARS)}`);
  const answers = request.answers?.length ? `\n\nHis answers to your questions:\n${request.answers.map((a) => `- ${a.question} → ${a.answer}`).join("\n")}` : "";
  return [
    `Chat: ${request.chatTitle} (${request.kind}${request.subject ? `, subject "${request.subject}"` : ""})`,
    `Conversation, oldest first:\n${lines.length ? lines.join("\n") : "(none yet)"}`,
    `Draft:\n${request.draft}${answers}`,
    `Talk to him in: ${request.askIn ?? DEFAULT_ASK_IN}`,
  ].join("\n\n");
}

export const compose = (request: ComposeRequest): Promise<ComposeResult> => credits.structured("sonnet", SYSTEM, prompt(request), Composed, MAX_TOKENS, "compose");
