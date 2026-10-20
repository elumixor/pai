import { el, motionMs } from "./dom.ts";

/**
 * The breadcrumbs over the chat: General › parent › … › here. One bar for every chat, so a
 * change is a difference, not a redraw: the crumbs that stay slide to where they now sit, the
 * ones that go fade out where they were, the new ones fade in. Each step before the last is a
 * button back to that place.
 */
export interface Crumb {
  /** What makes it the same crumb across changes: the row it stands for, not its wording. */
  readonly key: string;
  readonly label: string;
  readonly title?: string;
  readonly open?: () => void;
}

const SHIFT_PX = 10;

export function crumbBar() {
  /** The crumbs themselves; `node` is the header band that holds them and whatever sits under them. */
  const line = el("div.crumb-line");
  /**
   * Under the crumbs, centred: where the open chat puts its find bar. It belongs to the header
   * rather than floating over the conversation, and the band grows by its height when it is used.
   */
  const under = el("div.crumb-under");
  const node = el("nav.crumbs.home-crumbs", { "aria-label": "Where you are" }, line, under);

  /**
   * The band's height, published as `--band-h` and `--band-extra` (what it grew by), because three
   * other things are measured from it: the chat's own fade, the day pill that floats over it, and
   * what may be clipped. They used to carry the old number each, so opening the find bar left the
   * bar cropped, the fade ending above it and the pill at the wrong height — one value, decided
   * here, rather than three copies of it.
   */
  const BASE = 27;
  const publish = () => {
    const height = Math.round(node.getBoundingClientRect().height) || BASE;
    const root = document.documentElement.style;
    root.setProperty("--band-h", `${height}px`);
    root.setProperty("--band-extra", `${Math.max(0, height - BASE)}px`);
  };
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(publish).observe(node);
  publish();
  /** After the last crumb: the views of the place, when it has more than one. */
  const tail = el("span.crumb-tail");
  const shown = new Map<string, HTMLElement>();

  /**
   * A crumb's element outlives the crumb it was made from — it slides across redraws — so what a
   * click does is read from the crumb of the latest draw, never from the one captured when the
   * button was built. The stale closure is why General, last on the home page and reused as the
   * first crumb everywhere else, stopped being a way back.
   */
  const latest = new WeakMap<HTMLElement, Crumb>();

  const item = (crumb: Crumb) => {
    const button = el("button.crumb", { type: "button", title: crumb.title }, crumb.label) as HTMLButtonElement;
    const row = el("span.crumb-item", { "data-key": crumb.key }, el("span.crumb-sep", { "aria-hidden": "true" }, "›"), button);
    button.addEventListener("click", () => row.dataset.here !== "1" && latest.get(row)?.open?.());
    return row;
  };

  function set(crumbs: readonly Crumb[]) {
    const ms = motionMs();
    const keys = new Set(crumbs.map((c) => c.key));
    const before = new Map([...shown].map(([key, element]) => [key, element.getBoundingClientRect()]));
    const barBefore = line.getBoundingClientRect();

    // What leaves stays where it was, over the others, while it fades.
    for (const [key, element] of shown) {
      if (keys.has(key)) continue;
      shown.delete(key);
      const rect = before.get(key)!;
      if (!ms) {
        element.remove();
        continue;
      }
      element.classList.add("out");
      element.style.left = `${rect.left - barBefore.left}px`;
      element.style.top = `${rect.top - barBefore.top}px`;
      element.inert = true;
      setTimeout(() => element.remove(), ms);
    }

    // The new order, reusing what stays and making what is new.
    const fresh = new Set<string>();
    const ordered = crumbs.map((crumb) => {
      let element = shown.get(crumb.key);
      if (!element) {
        element = item(crumb);
        shown.set(crumb.key, element);
        fresh.add(crumb.key);
      }
      const button = element.querySelector<HTMLButtonElement>(".crumb")!;
      if (button.textContent !== crumb.label) button.textContent = crumb.label;
      if (crumb.title) button.title = crumb.title;
      else button.removeAttribute("title");
      latest.set(element, crumb);
      const here = crumb === crumbs[crumbs.length - 1];
      element.dataset.here = here ? "1" : "0";
      button.classList.toggle("here", here);
      button.disabled = here || !crumb.open;
      return element;
    });
    // The same crumbs in the same order: the words may have changed, nothing moves. Re-inserting
    // a node restarts its animation, so a redraw with nothing new must not touch the tree.
    const current = [...line.children].filter((c) => !c.classList.contains("out") && c !== tail);
    if (current.length === ordered.length && current.every((c, i) => c === ordered[i])) return;
    const leaving = [...line.querySelectorAll<HTMLElement>(".crumb-item.out")];
    line.replaceChildren(...ordered, tail, ...leaving);

    if (!ms) return;
    // The ones that stayed: from where they were (mid-move included) to where they now sit (FLIP).
    for (const element of ordered) {
      element.style.transition = "none";
      element.style.transform = "";
    }
    const barAfter = line.getBoundingClientRect();
    for (const element of ordered) {
      const key = element.dataset.key!;
      if (fresh.has(key)) {
        element.classList.add("in");
        setTimeout(() => element.classList.remove("in"), ms);
        continue;
      }
      const was = before.get(key);
      if (!was) continue;
      const now = element.getBoundingClientRect();
      const dx = was.left - barBefore.left - (now.left - barAfter.left);
      if (Math.abs(dx) < 0.5) {
        element.style.transition = "";
        continue;
      }
      element.style.transform = `translateX(${dx}px)`;
      // The start position has to be painted before the move back is asked for, or it jumps instead.
      void element.offsetWidth;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          element.style.transition = "";
          element.style.transform = "";
        }),
      );
    }
    node.style.setProperty("--shift", `${SHIFT_PX}px`);
  }

  /**
   * What the open place hangs under the crumbs. The band grows only while that thing is actually
   * showing (the find bar is `hidden` until ⌘F), which the stylesheet decides — holding a hidden
   * bar must not leave a gap under the crumbs.
   */
  const hold = (content?: HTMLElement) => {
    if (content && under.firstElementChild === content) return;
    under.replaceChildren(...(content ? [content] : []));
  };

  return { node, set, tail, hold };
}
