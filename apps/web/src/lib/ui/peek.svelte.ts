import type { IconName } from "../icons";

/** What the hover card over a row or a chip shows: a head of glyphs and names, the body rendered, a small foot. */
export interface PeekBody {
  readonly glyph?: IconName | "spinner";
  readonly title?: string;
  readonly dim?: string;
  readonly body?: string;
  readonly foot?: string;
}

export type MakePeek = () => PeekBody | Promise<PeekBody | undefined> | undefined;

/** Long enough not to flicker while he reads past a chip, short enough to feel like a hover. */
const OPEN_MS = 180;
/** The pointer travels from the chip to the card across a small gap: the card waits that long. */
const CLOSE_MS = 150;
/** A preview ends on a word, never mid-word, and never past this much of it. */
const PREVIEW_CHARS = 700;

/** `…` on a word boundary: a cut inside a word reads as a typo. */
export function preview(text: string, max = PREVIEW_CHARS) {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  const cut = trimmed.slice(0, max);
  const at = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("\n"));
  return `${cut.slice(0, at > max * 0.6 ? at : max).trimEnd()}…`;
}

/**
 * The one card every row and chip shares (`BodyPeek.svelte` draws it). It keeps itself open while the pointer is on
 * the trigger or on the card, with a grace period between the two.
 */
class BodyPeek {
  shown = $state<{ key: string; content: PeekBody; anchor: DOMRect } | null>(null);
  #openFor: string | undefined;
  #opening: ReturnType<typeof setTimeout> | undefined;
  #closing: ReturnType<typeof setTimeout> | undefined;

  hold() {
    clearTimeout(this.#closing);
    this.#closing = undefined;
  }

  closeSoon() {
    this.hold();
    this.#closing = setTimeout(() => this.dismiss(), CLOSE_MS);
  }

  dismiss() {
    clearTimeout(this.#opening);
    this.#openFor = undefined;
    this.shown = null;
  }

  /** An attachment: hovering the element opens the card, filled by `make` when it does. */
  arm = (key: string, make: MakePeek) => (node: HTMLElement) => {
    const enter = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      this.hold();
      clearTimeout(this.#opening);
      this.#opening = setTimeout(async () => {
        this.#openFor = key;
        const content = await make();
        if (this.#openFor !== key || !content || (!content.body?.trim() && !content.title)) return;
        this.shown = { key, content: { ...content, body: content.body ? preview(content.body) : undefined }, anchor: node.getBoundingClientRect() };
      }, OPEN_MS);
    };
    const leave = () => {
      clearTimeout(this.#opening);
      if (this.#openFor === key) this.closeSoon();
    };
    const click = () => this.dismiss();
    node.addEventListener("pointerenter", enter);
    node.addEventListener("pointerleave", leave);
    node.addEventListener("click", click);
    return () => {
      node.removeEventListener("pointerenter", enter);
      node.removeEventListener("pointerleave", leave);
      node.removeEventListener("click", click);
      if (this.#openFor === key) this.dismiss();
    };
  };
}

export const bodyPeek = new BodyPeek();
