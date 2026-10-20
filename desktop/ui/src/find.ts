import { clear, el } from "./dom.ts";
import { icon } from "./icons.ts";

/**
 * Find within the open conversation: ⌘F over the chat, matches marked where they are, enter and
 * shift-enter stepping through them, "3 of 17" saying where he is, escape closing and clearing.
 *
 * It searches the **data**, not the drawn rows: the chat holds far more than it has drawn, and a
 * match in a row that does not exist yet is still a match — the row is made (and unfolded, if it
 * is a folded bubble, a collapsed run of tool calls or an event behind a chevron) only when that
 * match is the one he is standing on. A count that promises matches he cannot reach is worse than
 * no count at all.
 */

export interface FindTarget {
  /** Stable across redraws, so stepping does not lose its place when a row is drawn again. */
  readonly key: string;
  readonly text: string;
  /** Draws it if needed, unfolds it if needed, and answers with the row — or nothing if it is gone. */
  reveal(): Promise<HTMLElement | undefined> | HTMLElement | undefined;
}

export interface FindOptions {
  /** Where the matches are marked: the scrolling column itself. */
  readonly scope: HTMLElement;
  readonly targets: () => readonly FindTarget[];
  /** The row he is looking at, so the scan starts there and the first match is the nearest one. */
  readonly anchorKey?: () => string | undefined;
  /** Pages further back, answering whether anything new arrived; the count says `+` while it can. */
  readonly loadMore?: () => Promise<boolean>;
  readonly canLoadMore?: () => boolean;
}

/**
 * The order to search in: the row he is on, then outward in both directions. What he is looking at
 * is where he expects the first hit, and a thread of thousands cannot be scanned before anything is
 * shown — so the scan goes in rings and the bar fills in as it widens.
 */
export function ring(length: number, anchor: number): number[] {
  const out: number[] = [];
  const start = Math.min(Math.max(0, anchor), Math.max(0, length - 1));
  for (let step = 0; out.length < length; step += 1) {
    if (start + step < length) out.push(start + step);
    if (step > 0 && start - step >= 0) out.push(start - step);
  }
  return out;
}

/** Where a needle sits in a haystack, every time: the pure half of the search. */
export function hitsIn(text: string, needle: string): number[] {
  if (!needle) return [];
  const haystack = text.toLowerCase();
  const found: number[] = [];
  for (let from = 0; ; ) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) return found;
    found.push(index);
    from = index + needle.length;
  }
}

/** Targets scanned between yields: enough to be quick, few enough that typing never waits. */
const CHUNK = 40;
const breathe = () => new Promise((resolve) => setTimeout(resolve, 0));

interface Hit {
  readonly key: string;
  /** Which occurrence inside that target, so two matches in one row are two places. */
  readonly nth: number;
}

export interface FindBar {
  readonly node: HTMLElement;
  /** Opens it, or steps to the next match when it is already open: ⌘F held walks the thread. */
  open(): void;
  /** `1` next, `-1` previous. */
  step(by: number): Promise<void>;
  close(): void;
  readonly showing: boolean;
}

const MARK = "find-hit";

export function findBar(options: FindOptions): FindBar {
  const input = el("input.find-input", { type: "search", placeholder: "Find in this conversation…", spellcheck: "false" }) as HTMLInputElement;
  const count = el("span.find-count");
  const node = el(
    "div.find-bar",
    { hidden: true },
    icon("search", 13),
    input,
    count,
    el("button.find-step", { title: "previous (⇧⏎)", onclick: () => step(-1) }, icon("chevron", 11)),
    el("button.find-step.next", { title: "next (⏎)", onclick: () => step(1) }, icon("chevron", 11)),
    el("button.find-close", { title: "close (esc)", onclick: () => close() }, icon("x", 12)),
  );

  let shown = false;
  let hits: Hit[] = [];
  let at = -1;
  /** Whether the first match of this search has already been jumped to. */
  let jumped = false;

  const query = () => input.value.trim();

  /**
   * Every occurrence of the query, found outward from where he is looking and reported as it goes:
   * the first match is shown the moment it exists, the count climbs while the rest is scanned, and
   * the next keystroke abandons the scan in flight rather than queueing behind it.
   */
  let scanning = 0;

  async function search() {
    const token = ++scanning;
    const needle = query().toLowerCase();
    hits = [];
    at = -1;
    unmark();
    draw();
    if (!needle) return;

    const targets = options.targets();
    const order = ring(targets.length, Math.max(0, targets.findIndex((t) => t.key === options.anchorKey?.())));
    const found = new Map<string, number[]>();
    let standing: Hit | undefined;

    for (let i = 0; i < order.length; i += CHUNK) {
      if (token !== scanning) return;
      for (const index of order.slice(i, i + CHUNK)) {
        const target = targets[index]!;
        const places = hitsIn(target.text, needle);
        if (places.length) found.set(target.key, places.map((_, nth) => nth));
      }
      // The list stays in reading order however the scan wandered, so stepping reads as the thread does.
      hits = targets.flatMap((t) => (found.get(t.key) ?? []).map((nth) => ({ key: t.key, nth })));
      if (!standing && hits.length) {
        // The nearest match to where he was looking: the first one the scan turned up.
        const nearest = order.find((index) => found.has(targets[index]!.key));
        const key = targets[nearest!]!.key;
        standing = hits.find((h) => h.key === key);
      }
      at = standing ? hits.findIndex((h) => h.key === standing!.key && h.nth === standing!.nth) : -1;
      draw();
      if (standing && !jumped) {
        jumped = true;
        await show();
        if (token !== scanning) return;
      }
      await breathe();
    }
    if (token === scanning) draw();
  }

  function draw() {
    const more = options.canLoadMore?.() ? "+" : "";
    count.textContent = query() ? (hits.length ? `${at + 1} of ${hits.length}${more}` : "no matches") : "";
    count.classList.toggle("none", Boolean(query()) && !hits.length);
  }

  /** Steps, and pages further back when he walks off the oldest match. */
  async function step(by: number) {
    if (!hits.length) return;
    if (at + by < 0 && options.loadMore && options.canLoadMore?.()) {
      const was = hits.length;
      if (await options.loadMore()) {
        const here = hits[at];
        jumped = true;
        await search();
        // Keep standing on the same match, which has moved down the list as older ones arrived.
        if (here) at = Math.max(0, hits.findIndex((h) => h.key === here.key && h.nth === here.nth));
        at += hits.length - was > 0 ? -1 : 0;
        at = Math.max(0, at);
        draw();
        return void (await show());
      }
    }
    at = (at + by + hits.length) % hits.length;
    draw();
    await show();
  }

  /** Puts him on the current match: the row drawn, unfolded, scrolled to, the occurrence marked. */
  async function show() {
    const hit = hits[at];
    if (!hit) return;
    const target = options.targets().find((t) => t.key === hit.key);
    const row = await target?.reveal();
    unmark();
    if (!row) return;
    const marks = mark(options.scope, query());
    row.scrollIntoView({ block: "center", behavior: "smooth" });
    // The nth occurrence of this row, among the marks the whole column now carries.
    const mine = marks.filter((m) => row.contains(m));
    const current = mine[hit.nth] ?? mine[0];
    current?.classList.add("current");
    current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function open() {
    // Already open: the key focuses the box and selects it (so typing replaces the query) and
    // still steps — one press has to be both "let me type" and "next", or he reaches for the mouse.
    if (shown) {
      input.focus();
      input.select();
      if (query() && hits.length) void step(1);
      return;
    }
    shown = true;
    node.hidden = false;
    input.focus();
    input.select();
    if (query()) {
      jumped = false;
      void search();
    }
  }

  function close() {
    shown = false;
    node.hidden = true;
    unmark();
    hits = [];
    at = -1;
  }

  input.addEventListener("input", () => {
    jumped = false;
    void search();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") return close();
    if (event.key !== "Enter") return;
    event.preventDefault();
    void step(event.shiftKey ? -1 : 1);
  });

  /** Marks every occurrence in what is drawn, and answers with them in document order. */
  function mark(scope: HTMLElement, needle: string): HTMLElement[] {
    unmark();
    if (!needle) return [];
    const lower = needle.toLowerCase();
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
      acceptNode: (text) => ((text.parentElement?.closest(`.${MARK}, script, style`) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) as number),
    });
    const texts: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if ((n.textContent ?? "").toLowerCase().includes(lower)) texts.push(n as Text);
    const made: HTMLElement[] = [];
    for (const text of texts) {
      const source = text.textContent ?? "";
      const out = document.createDocumentFragment();
      let last = 0;
      for (;;) {
        const index = source.toLowerCase().indexOf(lower, last);
        if (index < 0) break;
        out.append(source.slice(last, index));
        const hit = el(`mark.${MARK}`, {}, source.slice(index, index + needle.length));
        made.push(hit);
        out.append(hit);
        last = index + needle.length;
      }
      out.append(source.slice(last));
      text.replaceWith(out);
    }
    return made;
  }

  /** Puts the text back as it was: a highlight is never part of what a row says. */
  function unmark() {
    for (const hit of [...options.scope.querySelectorAll<HTMLElement>(`.${MARK}`)]) hit.replaceWith(document.createTextNode(hit.textContent ?? ""));
    options.scope.normalize();
  }

  return {
    node,
    open,
    step,
    close,
    get showing() {
      return shown;
    },
  };
}
