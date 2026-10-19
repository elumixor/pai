import { clear, el } from "./dom.ts";
import { markdown } from "./markdown.ts";

/**
 * The card a hover over a row opens: what was said, rendered — a native `title` tooltip printed
 * the markdown's own asterisks, which is what it was doing until now. One card serves every
 * trigger (a delegation, a report, an event, a task pill): the trigger that is hovered fills it.
 */
/** Long enough not to flicker while he reads past a chip, short enough to feel like a hover. */
const OPEN_MS = 180;
/** The pointer travels from the chip to the card across a small gap: the card waits that long. */
const CLOSE_MS = 150;
/** A preview ends on a word, never mid-word, and never past this much of it. */
const PREVIEW_CHARS = 700;

export interface PeekBody {
  /** The line over the body: glyphs and names, the tree's own vocabulary rather than words. */
  readonly head?: readonly (Node | string)[];
  readonly body?: string;
  /** The small line under it: whose it is, when it was. */
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

/** What fills the card: known at once, or read when the hover asks for it (a log row). */
export type MakeBody = () => PeekBody | Promise<PeekBody | undefined> | undefined;

export interface BodyPeek {
  /** This element opens the card, filled by `make` when it does. */
  arm(trigger: HTMLElement, key: string, make: MakeBody): void;
  dismiss(): void;
}

let shared: BodyPeek | undefined;

/**
 * The one card every row and chip shares; made on first use, since only a browser has a body.
 * It keeps itself open while the pointer is on the trigger **or** on the card, with a grace
 * period between the two: the card is not a child of the chip, so leaving the chip must not
 * close what the pointer is on its way to.
 */
export function bodyPeek(): BodyPeek {
  if (shared) return shared;
  const card = el("div.peek.body-peek", { hidden: true });
  document.body.append(card);
  let openFor: string | undefined;
  let opening: ReturnType<typeof setTimeout> | undefined;
  let closing: ReturnType<typeof setTimeout> | undefined;

  const cancelOpen = () => {
    if (opening) clearTimeout(opening);
    opening = undefined;
  };
  const hold = () => {
    if (closing) clearTimeout(closing);
    closing = undefined;
  };
  const hide = () => {
    card.hidden = true;
    card.replaceChildren();
    openFor = undefined;
  };
  const closeSoon = () => {
    hold();
    closing = setTimeout(hide, CLOSE_MS);
  };

  card.addEventListener("pointerenter", hold);
  card.addEventListener("pointerleave", closeSoon);

  async function show(trigger: HTMLElement, key: string, make: MakeBody) {
    const content = await make();
    // He may have moved on while a card's body was being read from the daemon.
    if (openFor !== key || !content || (!content.body?.trim() && !content.head?.length)) return;
    clear(
      card,
      content.head?.length ? el("div.peek-line", {}, ...content.head) : undefined,
      content.body?.trim() ? el("div.peek-body", {}, markdown(preview(content.body))) : undefined,
      content.foot ? el("div.peek-foot", {}, content.foot) : undefined,
    );
    card.hidden = false;
    const at = trigger.getBoundingClientRect();
    const left = Math.min(Math.max(8, at.left), window.innerWidth - card.offsetWidth - 8);
    const below = at.bottom + 8;
    const top = below + card.offsetHeight > window.innerHeight - 8 ? Math.max(8, at.top - card.offsetHeight - 8) : below;
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  }

  shared = {
    arm(trigger, key, make) {
      trigger.addEventListener("pointerenter", (event) => {
        if ((event as PointerEvent).pointerType === "touch") return;
        hold();
        cancelOpen();
        opening = setTimeout(() => {
          openFor = key;
          void show(trigger, key, make);
        }, OPEN_MS);
      });
      trigger.addEventListener("pointerleave", () => {
        cancelOpen();
        if (openFor === key) closeSoon();
      });
      // Opening whatever the chip points at should not leave its card behind.
      trigger.addEventListener("click", () => (cancelOpen(), hide()));
    },
    dismiss: () => (cancelOpen(), hide()),
  };
  return shared;
}
