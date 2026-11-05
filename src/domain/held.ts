import type { Question, SessionKind } from "./session.ts";
import type { Image } from "./attachments.ts";

/**
 * Conversations the daemon does not run but a message can still reach: a terminal's `claude`
 * (the mirror, `mirror.ts`, follows their transcripts). Whatever holds such threads registers a
 * `HeldThreads`; the frontends route a message to one before they fall back to a daemon session.
 */

/** The question a held conversation has open in its terminal's dialog, with the answers collected here so far. */
export interface HeldQuestion {
  readonly id: string;
  readonly questions: readonly Question[];
  readonly answers: Record<number, string>;
}

/** A held conversation, with what the frontends need to show it as a thread. */
export interface HeldThread {
  readonly id: string;
  readonly shortId: string;
  readonly kind: SessionKind;
  readonly cwd: string;
  readonly project?: string;
  readonly parent: null;
  readonly pending: undefined;
  readonly question: HeldQuestion | undefined;
  readonly costUsd: number;
  readonly state: "busy" | "idle";
  title: string;
  threadId: number | null;
  cardId: number | null;
  turns: number;
  recentTools: string[];
  persist(): void;
  summary(): Record<string, unknown>;
  send(text: string, opts?: { images?: Image[] }): void;
  answer(text: string): Promise<boolean>;
  interrupt(): Promise<boolean>;
}

export interface HeldThreads {
  readonly all: () => readonly HeldThread[];
  readonly find: (idOrShort: string) => HeldThread | undefined;
  /** The held thread a chat topic belongs to, unless the daemon runs that conversation itself right now. */
  readonly byThread: (threadId: number) => HeldThread | undefined;
}

const holders = new Map<string, HeldThreads>();

export const provide = (name: string, threads: HeldThreads) => void holders.set(name, threads);

const first = <T>(pick: (h: HeldThreads) => T | undefined) => {
  for (const h of holders.values()) {
    const found = pick(h);
    if (found) return found;
  }
  return undefined;
};

export const all = () => [...holders.values()].flatMap((h) => h.all());
export const find = (idOrShort: string) => first((h) => h.find(idOrShort));
export const byThread = (threadId: number) => first((h) => h.byThread(threadId));
