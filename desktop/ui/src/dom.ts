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

/** The page's motion in milliseconds, as the stylesheet has it; zero when the user asked for less of it. */
export const motionMs = (name: "fast" | "base" | "slow" = "base") => {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return 0;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(`--dur-${name}`).trim();
  return raw.endsWith("ms") ? parseFloat(raw) : raw.endsWith("s") ? parseFloat(raw) * 1000 : 200;
};

/**
 * Replaces what `container` shows with `next`, the old content fading out while the new one
 * settles in. The old nodes stay in the flow (absolutely placed over the new) for the fade,
 * so nothing jumps; a container that is empty just lets the new content enter.
 */
export function swap(container: HTMLElement, next: HTMLElement | undefined) {
  const ms = motionMs();
  const old = [...container.children].filter((c): c is HTMLElement => c instanceof HTMLElement && !c.classList.contains("leaving"));
  for (const node of old) {
    if (!ms) {
      node.remove();
      continue;
    }
    node.classList.add("leaving");
    node.inert = true;
    setTimeout(() => node.classList.contains("leaving") && node.remove(), ms);
  }
  if (!next) return;
  // Shown again while still fading out: it stays, and comes back.
  next.classList.remove("leaving");
  next.inert = false;
  next.classList.add("entering");
  container.append(next);
  if (ms) setTimeout(() => next.classList.remove("entering"), ms);
  else next.classList.remove("entering");
}

/** Marks a node new for one animation's length, so the stylesheet can let it in; `delay` staggers a run of them. */
export function fresh<T extends HTMLElement>(node: T, delay = 0): T {
  node.classList.add("fresh");
  if (delay) node.style.animationDelay = `${delay}ms`;
  const ms = motionMs("slow");
  if (ms)
    setTimeout(() => {
      node.classList.remove("fresh");
      node.style.removeProperty("animation-delay");
    }, ms + delay + 50);
  else node.classList.remove("fresh");
  return node;
}

/** The step between rows let in one after another, and how many steps before the rest come together. */
export const STAGGER_MS = 28;
export const STAGGER_MAX = 18;

/** A placeholder in the shape of what is coming: `skeleton("chat")`, `skeleton("list", 8)`. */
export function skeleton(shape: "list" | "board" | "lines", count = 6) {
  const box = el("div.skeleton", { class: `skeleton skeleton-${shape}`, "aria-hidden": "true" });
  if (shape === "board") {
    for (let c = 0; c < 4; c += 1) {
      const column = el("span.sk-col");
      column.append(el("span.sk-line", { style: "--w: 40%" }));
      for (let i = 0; i < 2 + ((c * 3) % 3); i += 1) column.append(el("span.sk-card"));
      box.append(column);
    }
  } else {
    const widths = [72, 54, 86, 40, 66, 48, 78, 58];
    for (let i = 0; i < count; i += 1) box.append(el("span.sk-line", { style: `--w: ${widths[i % widths.length]}%` }));
  }
  return box;
}

export function ago(iso: string | number) {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

/** "Today 14:13", "Yesterday 09:02", "Oct 7 10:40" — an instant as a person says it. */
export function stamp(at: number | string) {
  const day = new Date(at);
  const today = new Date();
  const clock = day.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  if (day.toDateString() === today.toDateString()) return `Today ${clock}`;
  if (day.toDateString() === new Date(today.getTime() - 86_400_000).toDateString()) return `Yesterday ${clock}`;
  return `${day.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(day.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) })} ${clock}`;
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
      closeSheet(sheet);
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
    sheet.addEventListener("cancel", (event) => {
      event.preventDefault();
      close();
    });
    document.body.append(sheet);
    sheet.showModal();
    inputs[0]?.focus();
  });
}

/** Closes a sheet the way it opened: it and its backdrop fade, then it is gone. */
export function closeSheet(box: HTMLDialogElement) {
  if (box.classList.contains("closing")) return;
  const ms = motionMs();
  const done = () => {
    if (box.open) box.close();
    box.remove();
  };
  if (!ms) return done();
  box.classList.add("closing");
  setTimeout(done, ms);
}

/** A wide sheet whose content a view renders into; closes on Escape or a click outside. Returns the content node. */
export function sheet(name: string) {
  const body = el("div.sheet-body");
  const box = el("dialog.sheet.wide", { class: `sheet wide ${name}`, onclick: (event: Event) => event.target === box && close() }, body) as HTMLDialogElement;
  const close = () => closeSheet(box);
  // Escape closes a modal dialog by itself: the fade has to run before that is let through.
  box.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  box.addEventListener("close", () => box.isConnected && box.remove());
  document.body.append(box);
  box.showModal();
  return { body, close };
}

/** One question, one answer. */
export const ask = async (label: string, initial = "") => (await dialog({ title: label, fields: [{ name: "value", label: "", value: initial, required: true }] }))?.value;

/** `claude-sonnet-5-20260501` reads as `sonnet 5`; an alias such as `sonnet` stays as it is. */
export function modelName(model: string | null | undefined) {
  if (!model) return "model?";
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(model);
  if (!m) return model;
  return `${m[1]} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}

/**
 * The top of an endless list: a spinner the caller puts first while older rows exist. Scrolled
 * within `reach` px of it, `load` runs, and again while it stays in reach (a short page fills the
 * view), until a load adds nothing. One load at a time; `pull` is the same, awaited, for callers.
 */
export function topLoader(root: HTMLElement, load: () => Promise<void>, reach = 800) {
  const node = el("div.list-loader", { role: "progressbar", "aria-label": "Loading earlier messages" }, el("span.spinner"));
  const near = () => node.isConnected && node.getBoundingClientRect().bottom > root.getBoundingClientRect().top - reach;
  let running: Promise<void> | undefined;
  const pull = () =>
    (running ??= (async () => {
      do {
        const height = root.scrollHeight;
        await load();
        if (root.scrollHeight === height) break;
        await new Promise(requestAnimationFrame);
      } while (near());
    })().finally(() => (running = undefined)));
  const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && void pull(), { root, rootMargin: `${reach}px 0px 0px 0px` });
  observer.observe(node);
  return { node, pull, dispose: () => observer.disconnect() };
}
