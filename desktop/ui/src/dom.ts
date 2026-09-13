type Attributes = Record<string, string | number | boolean | EventListener | undefined>;

/** `el("button.row", { onclick }, "Open")` — the whole view layer, no framework. */
export function el<K extends keyof HTMLElementTagNameMap>(
  selector: string,
  attributes: Attributes = {},
  ...children: (Node | string | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const [tag = "div", ...classes] = selector.split(".");
  const node = document.createElement(tag) as HTMLElementTagNameMap[K];
  if (classes.length) node.className = classes.join(" ");
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined) continue;
    if (typeof value === "function") node.addEventListener(name.replace(/^on/, ""), value);
    else node.setAttribute(name, String(value));
  }
  node.append(...children.filter((child): child is Node | string => Boolean(child)));
  return node;
}

export const clear = (node: HTMLElement, ...children: (Node | string)[]) => node.replaceChildren(...children);

export function ago(iso: string | number) {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

export const basename = (path: string) => path.split("/").filter(Boolean).pop() ?? path;
