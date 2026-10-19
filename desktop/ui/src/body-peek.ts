import { clear, el } from "./dom.ts";
import { hoverCard } from "./hover.ts";
import { markdown } from "./markdown.ts";

/**
 * The card a hover over a row opens: what was said, rendered — a native `title` tooltip printed
 * the markdown's own asterisks, which is what it was doing until now. One card serves every
 * trigger (a delegation, a report, an event, a task pill): the trigger that is hovered fills it.
 */
const HOVER_MS = 380;
/** A preview ends on a word, never mid-word, and never past this much of it. */
const PREVIEW_CHARS = 700;

export interface PeekBody {
  readonly body: string;
  /** The small line under it: when it was, what a click does. */
  readonly foot?: string;
}

/** `…` on a word boundary: a cut inside a word reads as a typo. */
export function preview(text: string, max = PREVIEW_CHARS) {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  const cut = trimmed.slice(0, max);
  const at = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("\n"));
  return `${cut.slice(0, at > max * 0.6 ? at : max).trimEnd()}…`;
}

export interface BodyPeek {
  /** This element opens the card, filled by `make` when it does. */
  arm(trigger: HTMLElement, key: string, make: () => PeekBody | undefined): void;
  dismiss(): void;
}

let shared: BodyPeek | undefined;

/** The one card every row and pill shares; made on first use, since only a browser has a body. */
export function bodyPeek(): BodyPeek {
  if (shared) return shared;
  const card = el("div.peek.body-peek", { hidden: true });
  document.body.append(card);
  const sources = new Map<string, () => PeekBody | undefined>();

  const peek = hoverCard(card, {
    openMs: HOVER_MS,
    show: (trigger, key) => {
      const content = sources.get(key)?.();
      if (!content?.body.trim()) return false;
      clear(card, el("div.peek-body", {}, markdown(preview(content.body))), content.foot ? el("div.peek-foot", {}, content.foot) : undefined);
      card.hidden = false;
      const at = trigger.getBoundingClientRect();
      const left = Math.min(Math.max(8, at.left), window.innerWidth - card.offsetWidth - 8);
      const below = at.bottom + 8;
      const top = below + card.offsetHeight > window.innerHeight - 8 ? Math.max(8, at.top - card.offsetHeight - 8) : below;
      card.style.left = `${left}px`;
      card.style.top = `${top}px`;
      return true;
    },
  });

  shared = {
    arm(trigger, key, make) {
      sources.set(key, make);
      peek.arm(trigger, key);
    },
    dismiss: () => peek.dismiss(),
  };
  return shared;
}
