import { ago, clear, el, until } from "./dom.ts";
import { prefs } from "./prefs.ts";
import type { Usage, UsageWindow } from "./types.ts";

/** The quota rings: one small arc per usage window, with what it means on hover. */

const tip = el("div.tooltip", { hidden: true });
document.body.append(tip);

export function showTip(anchor: HTMLElement, lines: (HTMLElement | undefined)[]) {
  clear(tip, ...lines);
  tip.removeAttribute("hidden");
  const box = anchor.getBoundingClientRect();
  tip.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - tip.offsetWidth - 8))}px`;
  tip.style.top = `${box.top - tip.offsetHeight - 8}px`;
}
export const hideTip = () => tip.setAttribute("hidden", "");

export function ring(window: UsageWindow, source?: string, label = false) {
  const { percent } = window;
  const r = 5.5;
  const c = 2 * Math.PI * r;
  const level = percent >= 90 ? "hot" : percent >= 70 ? "warm" : "cool";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 14 14");
  svg.setAttribute("class", `ring ${level}`);
  svg.innerHTML = `<circle cx="7" cy="7" r="${r}" class="track"/><circle cx="7" cy="7" r="${r}" class="fill" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - Math.min(100, percent) / 100)}" transform="rotate(-90 7 7)"/>`;
  const stat = el("span.stat.has-tip", {}, svg, el("span", {}, `${percent}%`), label ? el("span.dim", {}, window.name) : undefined);
  stat.addEventListener("mouseenter", () => {
    const left = window.resetsAt ? Math.max(0, new Date(window.resetsAt).getTime() - Date.now()) / 1000 : 0;
    const elapsed = window.length ? Math.round(100 - (left / window.length) * 100) : 0;
    showTip(stat, [
      el("strong", {}, window.name),
      el("span", {}, `${percent}% of the limit used`),
      window.resetsAt ? el("span", {}, `resets in ${until(window.resetsAt)} · ${elapsed}% of the ${window.length >= 86400 ? "week" : "window"} elapsed`) : undefined,
      source ? el("span.dim", {}, source) : undefined,
      el("span.dim", {}, "which rings show: settings → usage rings"),
    ]);
  });
  stat.addEventListener("mouseleave", hideTip);
  return stat;
}

/** The rings and the cost line for one usage reading, the hidden windows left out. */
export function usageStats(data: Usage, label = false) {
  const stats: HTMLElement[] = [el("span.stat", { title: "what the sessions have cost, as the SDK reports it" }, `$${data.costUsd.toFixed(2)}`)];
  const hidden = new Set(prefs().hiddenRings);
  const source = data.via ? `read on ${data.via} ${data.fetchedAt ? ago(data.fetchedAt) : ""}` : undefined;
  for (const window of data.windows) if (!hidden.has(window.name)) stats.push(ring(window, source, label));
  const session = data.windows.find((w) => w.name === "Session");
  if (session && !hidden.has("Session")) stats.push(el("span.stat.dim", { title: "time left in the five-hour window" }, until(session.resetsAt)));
  if (!data.windows.length) stats.push(el("span.stat.dim", { title: data.error ?? "" }, "no quota"));
  else if (data.error) stats.push(el("span.stat.dim", { title: data.error }, "stale"));
  return stats;
}
