type Attributes = Record<string, string | number | boolean | EventListener | undefined>;

/** `el("button.row", { onclick }, "Open")` — the whole view layer, no framework. */
export function el<K extends keyof HTMLElementTagNameMap>(
  selector: string,
  attributes: Attributes = {},
  ...children: (Node | string | undefined | false | null)[]
): HTMLElementTagNameMap[K] {
  const [tag = "div", ...classes] = selector.split(".");
  const node = document.createElement(tag) as HTMLElementTagNameMap[K];
  if (classes.length) node.className = classes.join(" ");
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined) continue;
    if (typeof value === "function") node.addEventListener(name.replace(/^on/, ""), value);
    else if (typeof value === "boolean") {
      if (value) node.setAttribute(name, "");
    } else node.setAttribute(name, String(value));
  }
  node.append(...children.filter((child): child is Node | string => Boolean(child)));
  return node;
}

export const clear = (node: HTMLElement, ...children: (Node | string | undefined | false)[]) =>
  node.replaceChildren(...children.filter((child): child is Node | string => Boolean(child)));

export function ago(iso: string | number) {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

/** "2h 10m", "35m", "now" — how long until an instant. */
export function until(iso: string | undefined) {
  if (!iso) return "";
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
  if (seconds <= 0) return "now";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export const basename = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

/** A one-line prompt box in the page rather than the browser's dialog, which Tauri lacks. */
export function ask(placeholder: string, initial = ""): Promise<string | undefined> {
  return new Promise((resolve) => {
    const input = el("input", { value: initial, placeholder }) as HTMLInputElement;
    const close = (value?: string) => {
      overlay.remove();
      resolve(value?.trim() || undefined);
    };
    const overlay = el(
      "div.overlay",
      { onclick: (event: Event) => event.target === overlay && close() },
      el(
        "form.prompt",
        {
          onsubmit: (event: Event) => {
            event.preventDefault();
            close(input.value);
          },
        },
        input,
        el("div.prompt-actions", {}, el("button.btn", { type: "button", onclick: () => close() }, "Cancel"), el("button.btn.primary", { type: "submit" }, "OK")),
      ),
    );
    document.body.append(overlay);
    input.focus();
    input.select();
  });
}
