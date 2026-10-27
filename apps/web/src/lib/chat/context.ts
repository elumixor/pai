import type { LogMessage } from "../types";
import type { ReplyQuote } from "./model";

/** What a row of a chat needs from the chat it is in. */
export interface RowContext {
  /** Whose log this is, and the side the other party sits on. */
  readonly agent: string;
  readonly parent: string;
  readonly nameOf: (party: string) => string;
  readonly mine: (m: LogMessage) => boolean;
  readonly isOpen: (key: string) => boolean;
  readonly toggle: (key: string) => void;
  readonly openAsks: ReadonlySet<number>;
  readonly answers: ReadonlyMap<number, string>;
  /** The quoted row, scrolled to and flashed. */
  readonly jump: (quote: ReplyQuote) => void;
  readonly openAgent: (slug: string, at?: number) => void;
  readonly answerAsk: (askId: number, text: string) => Promise<void>;
  readonly dropAsk: (askId: number) => Promise<void>;
  readonly answerQuestion: (session: string, text: string) => Promise<boolean>;
  /** "Answer in words": the question pinned to the box, the next message its answer. */
  readonly pinAnswer: (question: string, reply: (text: string) => Promise<unknown>) => void;
  readonly draftsChanged: () => void;
}
