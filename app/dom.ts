type Attributes = Record<string, string | number | boolean | EventListener | undefined>;

/** Small DOM helper: `el("button.action", { onclick }, "Restart")`. */
export function el<K extends keyof HTMLElementTagNameMap>(
  selector: string,
  attributes: Attributes = {},
  ...children: (Node | string | undefined)[]
): HTMLElementTagNameMap[K] {
  const [tag = "div", ...classes] = selector.split(".");
  const node = document.createElement(tag) as HTMLElementTagNameMap[K];
  if (classes.length) node.className = classes.join(" ");
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined) continue;
    if (typeof value === "function") node.addEventListener(name.replace(/^on/, ""), value);
    else node.setAttribute(name, String(value));
  }
  node.append(...children.filter((child): child is Node | string => child !== undefined));
  return node;
}

export function clear(node: HTMLElement, ...children: (Node | string)[]) {
  node.replaceChildren(...children);
}

export async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: init?.body ? { "content-type": "application/json" } : undefined });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

export const post = <T>(path: string, body: unknown) => json<T>(path, { method: "POST", body: JSON.stringify(body) });

export function ago(iso: string | number) {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

export function bytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 102.4) / 10} KB`;
  return `${Math.round(size / (1024 * 102.4)) / 10} MB`;
}
