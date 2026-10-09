import { commands as listCommands, fileIndex } from "./api.ts";
import { clear, el } from "./dom.ts";
import { icon } from "./icons.ts";
import type { SlashCommand } from "./types.ts";

export interface Attachment {
  readonly media_type: string;
  readonly data: string;
  readonly preview: string;
}

/** A pasted image as the base64 the API takes, plus a data URL for the chip. */
const readImage = (file: File) =>
  new Promise<Attachment>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const url = String(reader.result);
      resolve({ media_type: file.type, data: url.slice(url.indexOf(",") + 1), preview: url });
    };
    reader.readAsDataURL(file);
  });

export interface ComposeOptions {
  readonly placeholder: string;
  /** The directory `@` mentions are resolved in; none means no file mentions. */
  readonly projectPath?: () => string | undefined;
  /** The session whose slash commands `/` offers; none means no command menu. */
  readonly session?: () => string | undefined;
  readonly submit: (text: string, images: { media_type: string; data: string }[]) => Promise<void> | void;
  /** What the foot says on the left: the project, the recipient. */
  readonly foot?: () => string;
  /** The terminal look (`❯`, monospace) or the chat look. */
  readonly mono?: boolean;
}

export interface Compose {
  readonly node: HTMLElement;
  readonly input: HTMLTextAreaElement;
  readonly note: HTMLElement;
  /** Something the next message answers, shown above the box until it is sent or dismissed. */
  pin(content: HTMLElement | undefined, onDismiss?: () => void): void;
  disable(reason?: string): void;
  focus(): void;
}

/**
 * The message box every conversation here shares: `@` offers files of the project, `/` the
 * session's slash commands, a pasted image becomes a chip, enter sends and shift+enter breaks
 * the line.
 */
export function compose(options: ComposeOptions): Compose {
  const input = el("textarea", { rows: 1, placeholder: options.placeholder, spellcheck: false }) as HTMLTextAreaElement;
  const note = el("span.note");
  const chips = el("div.chips.attachments");
  const pinned = el("div.compose-pin", { hidden: true });
  const attachments: Attachment[] = [];
  let dismissPin: (() => void) | undefined;
  const drawChips = () =>
    clear(chips, ...attachments.map((a, i) => el("span.chip.image", {}, el("img", { src: a.preview, alt: "" }), el("button.iconbtn", { title: "remove", onclick: () => (attachments.splice(i, 1), drawChips()) }, icon("x", 11)))));
  input.addEventListener("paste", async (event) => {
    const files = [...(event.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    event.preventDefault();
    for (const file of files) attachments.push(await readImage(file));
    drawChips();
  });

  // One popup for both `@file` and `/command`: what it lists and what it inserts differ, the keys do not.
  interface Suggestion {
    readonly label: string;
    readonly hint?: string;
    readonly insert: string;
  }
  const mentions = el("div.mentions", { hidden: true });
  let index: string[] | undefined;
  let slash: SlashCommand[] | undefined;
  let menuStart = -1;
  let shown: Suggestion[] = [];
  const closeMenu = () => {
    mentions.setAttribute("hidden", "");
    menuStart = -1;
    shown = [];
  };
  const pick = (item: Suggestion) => {
    input.value = `${input.value.slice(0, menuStart)}${item.insert}${input.value.slice(input.selectionStart)}`;
    closeMenu();
    input.focus();
    input.selectionStart = input.selectionEnd = menuStart + item.insert.length;
    grow();
  };
  const showMenu = (items: Suggestion[]) => {
    shown = items;
    if (!items.length) return closeMenu();
    clear(
      mentions,
      ...items.map((item, i) =>
        el("button.mention", { class: `mention${i === 0 ? " active" : ""}`, onmousedown: (e: Event) => (e.preventDefault(), pick(item)) }, el("span.label", {}, item.label), item.hint ? el("span.dim.ellipsis", {}, item.hint) : undefined),
      ),
    );
    mentions.removeAttribute("hidden");
  };
  const showFiles = async (query: string) => {
    const root = options.projectPath?.();
    if (!root) return closeMenu();
    index ??= await fileIndex(root).catch(() => []);
    const q = query.toLowerCase();
    showMenu(index.filter((f) => f.toLowerCase().includes(q)).slice(0, 8).map((f) => ({ label: f, insert: `@${root}/${f} ` })));
  };
  // The commands are the process's own: skills, plugins, and Claude Code's built-ins that make sense off a terminal.
  const showCommands = async (query: string) => {
    const session = options.session?.();
    if (!session) return closeMenu();
    slash ??= await listCommands(session).catch(() => []);
    const q = query.toLowerCase();
    showMenu(
      slash
        .filter((c) => c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q))
        .sort((a, b) => Number(b.name.toLowerCase().startsWith(q)) - Number(a.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name))
        .slice(0, 10)
        .map((c) => ({ label: `/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ""}`, hint: c.description, insert: `/${c.name} ` })),
    );
  };
  input.addEventListener("input", () => {
    grow();
    const before = input.value.slice(0, input.selectionStart);
    const at = before.lastIndexOf("@");
    if (at >= 0 && (at === 0 || /\s/.test(before[at - 1]!)) && !/\s/.test(before.slice(at + 1))) {
      menuStart = at;
      return void showFiles(before.slice(at + 1));
    }
    if (before.startsWith("/") && !/\s/.test(before)) {
      menuStart = 0;
      return void showCommands(before.slice(1));
    }
    closeMenu();
  });

  const grow = () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(160, input.scrollHeight)}px`;
  };

  const submit = async () => {
    const text = input.value.trim();
    if ((!text && !attachments.length) || input.disabled) return;
    input.value = "";
    grow();
    closeMenu();
    const images = attachments.splice(0).map(({ media_type, data }) => ({ media_type, data }));
    drawChips();
    await options.submit(text, images);
  };

  input.addEventListener("keydown", (event) => {
    if (menuStart >= 0 && shown.length) {
      const rows = [...mentions.querySelectorAll<HTMLElement>(".mention")];
      const active = Math.max(0, rows.findIndex((r) => r.classList.contains("active")));
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const next = (active + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length;
        rows.forEach((r, i) => r.classList.toggle("active", i === next));
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        if (shown[active]) pick(shown[active]);
        return;
      }
      if (event.key === "Escape") return closeMenu();
    }
    if (event.key === "Escape" && dismissPin) return dismissPin();
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void submit();
    }
  });

  const foot = el("span.dim", {}, options.foot?.() ?? "");
  const node = el(
    "footer.compose",
    { class: `compose ${options.mono ? "tui-compose" : "chat-compose"}` },
    pinned,
    mentions,
    chips,
    el("div.compose-row", {}, options.mono ? el("span.prompt-char", {}, "❯") : undefined, input, options.mono ? undefined : el("button.iconbtn", { title: "send (enter)", onclick: () => void submit() }, icon("send", 14))),
    el("div.compose-foot", {}, foot, el("span.grow"), note, el("span.dim", {}, "enter to send · shift+enter newline")),
  );

  return {
    node,
    input,
    note,
    pin(content, onDismiss) {
      dismissPin = undefined;
      if (!content) {
        pinned.hidden = true;
        clear(pinned);
        return;
      }
      dismissPin = () => {
        this.pin(undefined);
        onDismiss?.();
      };
      clear(pinned, content, el("button.iconbtn.slim", { title: "not answering this (esc)", onclick: dismissPin }, icon("x", 11)));
      pinned.hidden = false;
      input.focus();
    },
    disable(reason) {
      input.disabled = Boolean(reason);
      input.placeholder = reason ?? options.placeholder;
    },
    focus: () => input.focus(),
  };
}
