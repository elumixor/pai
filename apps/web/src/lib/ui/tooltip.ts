/**
 * Every `title` on the page shows as the same small popover instead of the browser's own tooltip: the title is lifted
 * into `data-tip` the first time the pointer reaches the element, so the browser never gets to draw it. A line
 * break starts a dimmer second line.
 */
const OPEN_MS = 350;

export function installTooltips() {
  const tip = document.createElement("div");
  tip.className = "tooltip";
  tip.hidden = true;
  document.body.append(tip);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hide = () => {
    clearTimeout(timer);
    tip.hidden = true;
  };

  const show = (target: HTMLElement, text: string) => {
    tip.replaceChildren(
      ...text.split("\n").map((line, i) => {
        const span = document.createElement("span");
        if (i) span.className = "dim";
        span.textContent = line;
        return span;
      }),
    );
    tip.hidden = false;
    const box = target.getBoundingClientRect();
    tip.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - tip.offsetWidth - 8))}px`;
    const above = box.top - tip.offsetHeight - 8;
    tip.style.top = `${above < 0 ? box.bottom + 8 : above}px`;
  };

  const over = (event: MouseEvent) => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[title], [data-tip]");
    if (!target) return;
    if (target.title) {
      target.dataset.tip = target.title;
      target.removeAttribute("title");
    }
    const text = target.dataset.tip;
    if (!text) return;
    clearTimeout(timer);
    timer = setTimeout(() => target.matches(":hover") && show(target, text), OPEN_MS);
  };
  const out = (event: MouseEvent) => (event.target as HTMLElement | null)?.closest("[data-tip]") && hide();

  document.addEventListener("mouseover", over);
  document.addEventListener("mouseout", out);
  document.addEventListener("mousedown", hide, true);
  return () => {
    document.removeEventListener("mouseover", over);
    document.removeEventListener("mouseout", out);
    document.removeEventListener("mousedown", hide, true);
    tip.remove();
  };
}
