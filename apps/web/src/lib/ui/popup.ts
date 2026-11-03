/** The surface every floating menu shares (keep's): a rounded panel with room around its rows (rows are `h-9 px-2.5`). */
export const POPUP = "rounded-lg bg-surface p-1.5 text-[14px] text-ink shadow-float";

/**
 * Moves an element to the body: an ancestor with layout containment (a container query's box) would anchor its
 * `position: fixed` to itself instead of the window.
 */
export function portal(node: HTMLElement) {
  document.body.appendChild(node);
  return { destroy: () => node.remove() };
}
