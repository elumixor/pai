/** A row to scroll to and flash: a message, an ask, a task's rows, or the open question. */
export interface RevealTarget {
  readonly messageId?: number;
  readonly askId?: number;
  readonly taskId?: number;
  readonly question?: boolean;
}

/**
 * A row asked for before the chat that holds it is on screen (the bell, a `^id` chip, the hand). The chat that opens
 * next for `chat` takes it and scrolls there once it has loaded.
 */
class Reveal {
  pending = $state<{ chat: string; target: RevealTarget } | null>(null);

  ask(chat: string, target: RevealTarget) {
    this.pending = { chat, target };
  }

  /** The target waiting for this chat, taken so it is used once. */
  take(chat: string) {
    const found = this.pending?.chat === chat ? this.pending.target : undefined;
    if (found) this.pending = null;
    return found;
  }
}

export const reveal = new Reveal();
