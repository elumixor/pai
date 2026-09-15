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

export interface Field {
  readonly name: string;
  readonly label: string;
  readonly placeholder?: string;
  readonly value?: string;
  readonly required?: boolean;
}

export interface DialogSpec {
  readonly title: string;
  readonly description?: string;
  readonly fields: readonly Field[];
  readonly submit?: string;
}

/** A small sheet with a few fields, in the page's own style; the browser's `prompt` is not available in a Tauri window. */
export function dialog(spec: DialogSpec): Promise<Record<string, string | undefined> | undefined> {
  return new Promise((resolve) => {
    const inputs = spec.fields.map((field) => el("input", { name: field.name, value: field.value ?? "", placeholder: field.placeholder ?? "", required: Boolean(field.required) }) as HTMLInputElement);
    const close = (values?: Record<string, string>) => {
      sheet.close();
      sheet.remove();
      resolve(values);
    };
    const sheet = el(
      "dialog.sheet",
      { onclick: (event: Event) => event.target === sheet && close(), onclose: () => sheet.isConnected && close() },
      el(
        "form",
        {
          method: "dialog",
          onsubmit: (event: Event) => {
            event.preventDefault();
            close(Object.fromEntries(inputs.map((input) => [input.name, input.value.trim()])));
          },
        },
        el("h3", {}, spec.title),
        spec.description ? el("p.dim", {}, spec.description) : undefined,
        ...spec.fields.map((field, index) => el("label.sheet-field", {}, el("span", {}, field.label), inputs[index]!)),
        el("div.sheet-actions", {}, el("button.btn", { type: "button", onclick: () => close() }, "Cancel"), el("button.btn.primary", { type: "submit" }, spec.submit ?? "OK")),
      ),
    ) as HTMLDialogElement;
    sheet.addEventListener("keydown", (event) => event.key === "Escape" && close());
    document.body.append(sheet);
    sheet.showModal();
    inputs[0]?.focus();
  });
}

/** A wide sheet whose content a view renders into; closes on Escape or a click outside. Returns the content node. */
export function sheet(name: string) {
  const body = el("div.sheet-body");
  const box = el("dialog.sheet.wide", { class: `sheet wide ${name}`, onclick: (event: Event) => event.target === box && close() }, body) as HTMLDialogElement;
  const close = () => {
    box.close();
    box.remove();
  };
  box.addEventListener("close", () => box.isConnected && box.remove());
  document.body.append(box);
  box.showModal();
  return { body, close };
}

/** One question, one answer. */
export const ask = async (label: string, initial = "") => (await dialog({ title: label, fields: [{ name: "value", label: "", value: initial, required: true }] }))?.value;
