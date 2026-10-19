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
  const node = el("nav.crumbs.home-crumbs", { "aria-label": "Where you are" });
  /** After the last crumb: the views of the place, when it has more than one. */
  const tail = el("span.crumb-tail");
  const shown = new Map<string, HTMLElement>();

  const item = (crumb: Crumb) => {
    const button = el("button.crumb", { type: "button", title: crumb.title }, crumb.label) as HTMLButtonElement;
    button.addEventListener("click", () => shown.get(crumb.key)?.dataset.here !== "1" && crumb.open?.());
    return el("span.crumb-item", { "data-key": crumb.key }, el("span.crumb-sep", { "aria-hidden": "true" }, "›"), button);
  };

  function set(crumbs: readonly Crumb[]) {
    const ms = motionMs();
    const keys = new Set(crumbs.map((c) => c.key));
    const before = new Map([...shown].map(([key, element]) => [key, element.getBoundingClientRect()]));
    const barBefore = node.getBoundingClientRect();

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
      const here = crumb === crumbs[crumbs.length - 1];
      element.dataset.here = here ? "1" : "0";
      button.classList.toggle("here", here);
      button.disabled = here || !crumb.open;
      return element;
    });
    // The same crumbs in the same order: the words may have changed, nothing moves. Re-inserting
    // a node restarts its animation, so a redraw with nothing new must not touch the tree.
    const current = [...node.children].filter((c) => !c.classList.contains("out") && c !== tail);
    if (current.length === ordered.length && current.every((c, i) => c === ordered[i])) return;
    const leaving = [...node.querySelectorAll<HTMLElement>(".crumb-item.out")];
    node.replaceChildren(...ordered, tail, ...leaving);

    if (!ms) return;
    // The ones that stayed: from where they were (mid-move included) to where they now sit (FLIP).
    for (const element of ordered) {
      element.style.transition = "none";
      element.style.transform = "";
    }
    const barAfter = node.getBoundingClientRect();
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

  return { node, set, tail };
}
