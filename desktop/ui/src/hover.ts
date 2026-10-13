/**
 * A card that a long hover opens and the pointer can reach. Intent opens it: a delay, skipped
 * while a card is open or was just closed, so running down a list switches at once. Leaving the
 * trigger keeps it open while the pointer travels inside the triangle from where it left to the
 * card's near edge, and only while it keeps moving: a pointer that rests there is not on its way.
 * Anywhere else it closes after a short grace. A row crossed on the way to the card does not take
 * the card over. The pattern of macOS submenus and Floating UI's `safePolygon`; a card opened
 * from inside another (`nested`) counts as inside it, so a chain of them stays reachable. A card
 * that is `sticky` (an answer being typed in it) ignores the pointer: a click outside or Escape.
 */
const WARM_MS = 400;
const GRACE_MS = 140;
const REST_MS = 280;
const RETRY_MS = 60;
/** The triangle's tip sits this far behind the exit point, so a jitter at the edge stays in. */
const BUFFER = 6;

interface Point {
  readonly x: number;
  readonly y: number;
}

export interface HoverCard {
  readonly node: HTMLElement;
  /** Makes a row open the card; a row drawn anew for the open key takes over as its trigger. */
  arm(trigger: HTMLElement, key: string): void;
  /** Closes the card and forgets an opening that was on its way. */
  dismiss(): void;
  /** The key the card is open for. */
  shown(): string | undefined;
  /** The point is on the card or on one opened from it. */
  holds(p: Point): boolean;
  /** Open and not to be closed by the pointer leaving. */
  pinned(): boolean;
}

const within = (r: DOMRect, p: Point) => p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
const side = (a: Point, b: Point, p: Point) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);

/** The triangle from the point the pointer left at to the near edge of the card. */
function aimed(from: Point, card: DOMRect, p: Point) {
  const [tip, a, b] =
    card.left >= from.x
      ? [{ x: from.x - BUFFER, y: from.y }, { x: card.left, y: card.top }, { x: card.left, y: card.bottom }]
      : card.right <= from.x
        ? [{ x: from.x + BUFFER, y: from.y }, { x: card.right, y: card.top }, { x: card.right, y: card.bottom }]
        : card.top >= from.y
          ? [{ x: from.x, y: from.y - BUFFER }, { x: card.left, y: card.top }, { x: card.right, y: card.top }]
          : [{ x: from.x, y: from.y + BUFFER }, { x: card.left, y: card.bottom }, { x: card.right, y: card.bottom }];
  const [s1, s2, s3] = [side(tip, a, p), side(a, b, p), side(b, tip, p)];
  return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
}

export function hoverCard(
  node: HTMLElement,
  options: {
    readonly openMs: number;
    /** Fills and places the card for a trigger; false when there is nothing to show. */
    readonly show: (trigger: HTMLElement, key: string) => boolean | Promise<boolean>;
    readonly nested?: () => readonly HoverCard[];
    readonly sticky?: () => boolean;
    readonly onHide?: () => void;
  },
): HoverCard {
  let open = false;
  let key: string | undefined;
  let trigger: HTMLElement | undefined;
  let pending: { trigger: HTMLElement; key: string } | undefined;
  let exit: Point | undefined;
  let pointer: Point = { x: -1, y: -1 };
  let movedAt = 0;
  let closedAt = 0;
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  const holds = (p: Point) => open && (within(node.getBoundingClientRect(), p) || (options.nested?.() ?? []).some((c) => c.holds(p)));
  const pinned = () => open && (Boolean(options.sticky?.()) || (options.nested?.() ?? []).some((c) => c.pinned()));
  const onTrigger = (p: Point) => Boolean(trigger?.isConnected && within(trigger.getBoundingClientRect(), p));
  const heading = () => Boolean(open && exit && Date.now() - movedAt < REST_MS && aimed(exit, node.getBoundingClientRect(), pointer));

  const cancelClose = () => {
    clearTimeout(closeTimer);
    closeTimer = undefined;
  };
  const closeIn = (ms: number) => {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => close(), ms);
  };

  function close(force = false) {
    cancelClose();
    if (!open || (!force && pinned())) return;
    open = false;
    node.hidden = true;
    closedAt = Date.now();
    key = trigger = exit = undefined;
    options.onHide?.();
  }

  function dismiss() {
    clearTimeout(openTimer);
    pending = undefined;
    close(true);
  }

  async function attempt() {
    const want = pending;
    if (!want || !want.trigger.isConnected) return;
    if (heading()) return void (openTimer = setTimeout(attempt, RETRY_MS));
    if (!within(want.trigger.getBoundingClientRect(), pointer)) return;
    const ok = await options.show(want.trigger, want.key);
    if (pending !== want) return;
    pending = undefined;
    if (!ok) return close();
    [open, key, trigger, exit] = [true, want.key, want.trigger, undefined];
    node.hidden = false;
    // The pointer may have left while the card was filled: it closes as it would have anyway.
    if (holds(pointer) || onTrigger(pointer)) cancelClose();
    else closeIn(GRACE_MS);
  }

  function track(event: PointerEvent) {
    if (event.pointerType === "touch") return;
    pointer = { x: event.clientX, y: event.clientY };
    movedAt = Date.now();
    if (!open) return;
    if (holds(pointer) || onTrigger(pointer)) {
      exit = undefined;
      return cancelClose();
    }
    if (exit && aimed(exit, node.getBoundingClientRect(), pointer)) return closeIn(REST_MS);
    exit = undefined;
    if (!closeTimer) closeIn(GRACE_MS);
  }

  document.addEventListener("pointermove", track, { passive: true });
  document.addEventListener("keydown", (event) => event.key === "Escape" && dismiss());
  // A scroll moves the trigger from under the card; one inside the card is the card's own.
  document.addEventListener("scroll", (event) => open && !(event.target instanceof Node && node.contains(event.target)) && !(options.nested?.() ?? []).some((c) => event.target instanceof Node && c.node.contains(event.target)) && dismiss(), { capture: true, passive: true });
  document.addEventListener("pointerdown", (event) => open && !holds({ x: event.clientX, y: event.clientY }) && !onTrigger({ x: event.clientX, y: event.clientY }) && dismiss(), { capture: true });
  window.addEventListener("blur", () => !pinned() && dismiss());

  return {
    node,
    dismiss,
    shown: () => (open ? key : undefined),
    holds,
    pinned,
    arm(row, rowKey) {
      if (open && key === rowKey) trigger = row;
      if (pending?.key === rowKey) pending.trigger = row;
      row.addEventListener("pointerenter", (event) => {
        if (event.pointerType === "touch") return;
        pointer = { x: event.clientX, y: event.clientY };
        if (open && key === rowKey) {
          trigger = row;
          exit = undefined;
          return cancelClose();
        }
        clearTimeout(openTimer);
        pending = { trigger: row, key: rowKey };
        const warm = open || Date.now() - closedAt < WARM_MS;
        openTimer = setTimeout(attempt, warm ? 0 : options.openMs);
      });
      row.addEventListener("pointerleave", (event) => {
        if (pending?.trigger === row && !open) {
          clearTimeout(openTimer);
          pending = undefined;
        }
        if (open && trigger === row) exit = { x: event.clientX, y: event.clientY };
      });
      row.addEventListener("pointerdown", dismiss);
    },
  };
}
