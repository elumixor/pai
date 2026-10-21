import { commands as listCommands, fileIndex, latestModels, usage } from "./api.ts";
import { el, modelName } from "./dom.ts";
import { icon } from "./icons.ts";
import { menu } from "./menu.ts";
import { miniRings } from "./rings.ts";
import { clearDraft, loadDraft, saveDraft, type DraftPart } from "./drafts.ts";
import type { Effort, SlashCommand, Usage } from "./types.ts";

/** The model and effort a conversation runs with, resolved: what was asked for, else what it runs with anyway. */
export interface Prefs {
  readonly model?: string | null;
  readonly effort?: Effort | null;
}
/** Families, not versions: the daemon resolves each to its newest model, which `GET /models` names. */
const FAMILIES = ["fable", "opus", "sonnet", "haiku"] as const;
let newest: Promise<Record<string, { id: string; name: string }>> | undefined;
const models = async () => {
  newest ??= latestModels().catch(() => ((newest = undefined), {}));
  const latest = await newest;
  return FAMILIES.filter((f) => latest[f] || f !== "fable").map((f) => ({ value: f, label: latest[f]?.name.replace(/^Claude /, "") ?? capital(f) }));
};
const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** An attachment as every route takes it: base64, its type, and the name he knows it by. */
export interface Attached {
  readonly media_type: string;
  readonly data: string;
  readonly name?: string;
}

export interface Attachment {
  readonly media_type: string;
  readonly data: string;
  /** A data URL for a picture's thumbnail; a document has none. */
  readonly preview: string;
  /** What he calls it, which is what the row and the turn say. */
  readonly name?: string;
  readonly size?: number;
}

/** Anything he attaches, as the API takes it: base64, with its name, and a preview for a picture. */
const readFile = (file: File) =>
  new Promise<Attachment>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const url = String(reader.result);
      const picture = file.type.startsWith("image/");
      resolve({ media_type: file.type, data: url.slice(url.indexOf(",") + 1), preview: picture ? url : "", name: file.name, size: file.size });
    };
    reader.readAsDataURL(file);
  });

/** The limits the daemon enforces, said here too so he hears them while attaching. */
const MAX_BYTES = 25 * 1024 * 1024;
const UNREADABLE = /\.(zip|rar|7z|tar|gz|tgz|bz2|exe|dmg|pkg|app|iso|bin|so|dylib|dll|xls|xlsx|doc|docx|ppt|pptx|key|numbers|pages|mp4|mov|avi|mkv|mp3|wav|m4a)$/i;
export const sizeOf = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** Why this file cannot go, in his words, or nothing when it can. */
export function refuseFile(file: File): string | undefined {
  if (file.size > MAX_BYTES) return `${file.name} is ${sizeOf(file.size)} — the limit is ${sizeOf(MAX_BYTES)}`;
  if (!file.size) return `${file.name} is empty`;
  if (UNREADABLE.test(file.name)) return `${file.name} is a kind the model cannot read — put it in a repo and say where`;
  return undefined;
}

// A paste longer than this collapses into a chip instead of filling the box with raw text.
const DRAFT_PREFIX = "pai.draft:";
const CHUNK_CHARS = 400;
const CHUNK_LINES = 8;

type Chip = { kind: "image"; attachment: Attachment } | { kind: "file"; attachment: Attachment } | { kind: "text"; text: string };

/** `plaintext-only` keeps formatting out (no bold/links pasted in) while still letting line breaks through; older engines fall back to plain editing. */
const PLAINTEXT_EDITABLE = (() => {
  const probe = document.createElement("div");
  probe.contentEditable = "plaintext-only";
  return probe.contentEditable === "plaintext-only";
})();

export interface ComposeOptions {
  readonly placeholder: string;
  /** The directory `@` mentions are resolved in; none means no file mentions. */
  readonly projectPath?: () => string | undefined;
  /** The session whose slash commands `/` offers; none means no command menu. */
  readonly session?: () => string | undefined;
  readonly submit: (text: string, images: readonly Attached[]) => Promise<void> | void;
  /** What the foot says on the left: the project, the recipient. */
  readonly foot?: () => string;
  /** The terminal look (`❯`, monospace) or the chat look. */
  readonly mono?: boolean;
  /** The chat look's foot: the model and the effort, changeable when `setPrefs` is given, and the quota rings. */
  readonly prefs?: () => Prefs | undefined;
  readonly setPrefs?: (changes: Prefs) => Promise<{ error?: string }>;
  /** A control of the host's in the chat look's foot, after the effort (pai's "new thread" switch). */
  readonly extra?: HTMLElement;
  /** Identifies this box's draft, so what he typed and did not send survives a reload. */
  readonly draftKey?: string;
}

export interface Compose {
  readonly node: HTMLElement;
  readonly input: HTMLElement;
  readonly note: HTMLElement;
  /** Something the next message answers, shown above the box until it is sent or dismissed. */
  pin(content: HTMLElement | undefined, onDismiss?: () => void): void;
  disable(reason?: string): void;
  /** Says something else in the empty box for a while; none puts the usual words back. */
  placeholder(text?: string): void;
  focus(): void;
  /** The model or effort changed elsewhere: the foot follows. */
  refreshPrefs(): void;
}

/**
 * The message box every conversation here shares: `@` offers files of the project, `/` the
 * session's slash commands, a pasted image or a long paste becomes a chip right where it was
 * dropped — one message can interleave plain text and attachments, in order. Enter sends,
 * shift+enter breaks the line.
 */
export function compose(options: ComposeOptions): Compose {
  const input = el("div.input", { contenteditable: PLAINTEXT_EDITABLE ? "plaintext-only" : "true", role: "textbox", "aria-multiline": "true", "data-placeholder": options.placeholder }) as HTMLElement;
  const note = el("span.note");
  const pinned = el("div.compose-pin", { hidden: true });
  const chips = new WeakMap<HTMLElement, Chip>();
  let dismissPin: (() => void) | undefined;

  /** A true-empty element is what the CSS placeholder hooks on; a stray trailing `<br>` would hide it. */
  const settle = () => {
    if (!input.textContent?.trim() && !input.querySelector(".inline-chip")) input.replaceChildren();
  };

  const selectionRange = (): Range | undefined => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && input.contains(sel.anchorNode)) return sel.getRangeAt(0).cloneRange();
    return undefined;
  };
  const endRange = () => {
    const r = document.createRange();
    r.selectNodeContents(input);
    r.collapse(false);
    return r;
  };

  const removeChip = (span: HTMLElement) => {
    span.remove();
    chips.delete(span);
    settle();
    input.focus();
  };
  const chipNode = (chip: Chip) => {
    const body =
      chip.kind === "image"
        ? [el("img", { src: chip.attachment.preview, alt: "" })]
        : chip.kind === "file"
          ? [icon("file", 11), el("span", {}, `${chip.attachment.name ?? "file"} · ${sizeOf(chip.attachment.size ?? 0)}`)]
          : [icon("file", 11), el("span", {}, `Pasted text · ${chip.text.length.toLocaleString()} chars`)];
    const span = el("span.chip.inline-chip", { class: `chip inline-chip ${chip.kind}`, contenteditable: "false" }, ...body, el("button.chip-remove", { type: "button", tabindex: -1, title: "remove", onmousedown: (e: Event) => e.preventDefault(), onclick: () => removeChip(span) }, icon("x", 10)));
    chips.set(span, chip);
    return span;
  };
  /** Drops a chip at the caret (or the end, when nothing is focused there), with room for the caret right after it. */
  /** One file he chose or dropped: refused with a reason, or a chip of the right kind. */
  const offer = async (file: File) => {
    const why = refuseFile(file);
    if (why) {
      note.textContent = why;
      return;
    }
    note.textContent = "";
    const attachment = await readFile(file);
    insertChip({ kind: file.type.startsWith("image/") ? "image" : "file", attachment });
  };

  const insertChip = (chip: Chip) => {
    const range = selectionRange() ?? endRange();
    range.deleteContents();
    const spacer = document.createTextNode(" ");
    range.insertNode(spacer);
    const beforeSpacer = document.createRange();
    beforeSpacer.setStartBefore(spacer);
    beforeSpacer.collapse(true);
    beforeSpacer.insertNode(chipNode(chip));
    const after = document.createRange();
    after.setStart(spacer, 1);
    after.collapse(true);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(after);
    input.normalize();
    settle();
    input.focus();
  };

  input.addEventListener("paste", async (event) => {
    const files = [...(event.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
    if (files.length) {
      event.preventDefault();
      for (const file of files) await offer(file);
      return;
    }
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (text.length > CHUNK_CHARS || text.split("\n").length > CHUNK_LINES) {
      event.preventDefault();
      insertChip({ kind: "text", text });
    }
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
  /** The run of text `@`/`/` opened on: its node (merged by `normalize()`, so always one run) and where in it the trigger sits. */
  let menuNode: Text | undefined;
  let menuStart = -1;
  let shown: Suggestion[] = [];
  const closeMenu = () => {
    mentions.setAttribute("hidden", "");
    menuNode = undefined;
    menuStart = -1;
    shown = [];
  };
  const pick = (item: Suggestion) => {
    const node = menuNode;
    if (!node?.isConnected) return closeMenu();
    const caret = selectionRange();
    const end = caret?.collapsed && caret.startContainer === node ? caret.startOffset : node.length;
    node.textContent = `${node.textContent!.slice(0, menuStart)}${item.insert}${node.textContent!.slice(end)}`;
    closeMenu();
    input.focus();
    const range = document.createRange();
    range.setStart(node, menuStart + item.insert.length);
    range.collapse(true);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  };
  const showMenu = (items: Suggestion[]) => {
    shown = items;
    if (!items.length) return closeMenu();
    mentions.replaceChildren(
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
    input.normalize();
    settle();
    const range = selectionRange();
    const node = range?.collapsed ? range.startContainer : undefined;
    if (!node || node.nodeType !== Node.TEXT_NODE) return closeMenu();
    const text = node as Text;
    const before = text.textContent!.slice(0, range!.startOffset);
    const at = before.lastIndexOf("@");
    if (at >= 0 && (at === 0 || /\s/.test(before[at - 1]!)) && !/\s/.test(before.slice(at + 1))) {
      menuNode = text;
      menuStart = at;
      return void showFiles(before.slice(at + 1));
    }
    // A command only reads as one at the very start of the message: no earlier sibling in its run.
    if (!text.previousSibling && before.startsWith("/") && !/\s/.test(before)) {
      menuNode = text;
      menuStart = 0;
      return void showCommands(before.slice(1));
    }
    closeMenu();
  });

  /** What is in the box right now: the text with its pasted chunks in place, and the pictures. */
  const contents = () => {
    let text = "";
    const images: Attached[] = [];
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) return void (text += node.textContent ?? "");
      if (node.nodeName === "BR") return void (text += "\n");
      const chip = node instanceof HTMLElement ? chips.get(node) : undefined;
      if (chip?.kind === "image" || chip?.kind === "file")
        return void images.push({ media_type: chip.attachment.media_type, data: chip.attachment.data, name: chip.attachment.name });
      if (chip?.kind === "text") return void (text += chip.text);
      node.childNodes.forEach(walk);
    };
    input.childNodes.forEach(walk);
    text = text.replace(/ /g, " ");
    return { text: text.trim(), images };
  };

  /** The box as draft parts, in the order he typed them, so a reload puts the chips back where they were. */
  const parts = (): DraftPart[] => {
    const out: DraftPart[] = [];
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) return void out.push({ kind: "text", text: node.textContent ?? "" });
      if (node.nodeName === "BR") return void out.push({ kind: "text", text: "\n" });
      const chip = node instanceof HTMLElement ? chips.get(node) : undefined;
      if (chip?.kind === "image" || chip?.kind === "file") return void out.push({ kind: "image", ...chip.attachment });
      if (chip?.kind === "text") return void out.push({ kind: "paste", text: chip.text });
      node.childNodes.forEach(walk);
    };
    input.childNodes.forEach(walk);
    return out.filter((p) => p.kind !== "text" || p.text);
  };

  /** The draft outlives a reload — pictures too, which is why it lives in IndexedDB and not in localStorage. */
  const draftKey = options.draftKey ? `${DRAFT_PREFIX}${options.draftKey}` : undefined;
  let saving: ReturnType<typeof setTimeout> | undefined;
  const keepDraft = () => {
    if (!draftKey) return;
    if (saving) clearTimeout(saving);
    saving = setTimeout(() => void saveDraft(draftKey, parts()), 300);
  };
  input.addEventListener("input", keepDraft);

  const submit = async () => {
    if (input.getAttribute("contenteditable") === "false") return;
    const { text, images } = contents();
    if (!text && !images.length) return;
    input.replaceChildren();
    settle();
    closeMenu();
    if (draftKey) void clearDraft(draftKey);
    await options.submit(text, images);
  };

  input.addEventListener("keydown", (event) => {
    if (menuNode && shown.length) {
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

  // The foot: attach, the model, the effort, the rings; the note; enter.
  const picker = el("input", { type: "file", multiple: true, hidden: true }) as HTMLInputElement;
  picker.addEventListener("change", async () => {
    for (const file of picker.files ?? []) await offer(file);
    picker.value = "";
  });
  const modelButton = el("button.compose-tool.model", { title: "the model this conversation runs with" }) as HTMLButtonElement;
  const effortButton = el("button.compose-tool.effort", { title: "how hard it thinks" }) as HTMLButtonElement;
  const drawPrefs = () => {
    const prefs = options.prefs?.();
    modelButton.hidden = !prefs;
    effortButton.hidden = !prefs;
    if (!prefs) return;
    modelButton.hidden = !prefs.model;
    effortButton.hidden = !prefs.effort;
    modelButton.textContent = prefs.model ? capital(modelName(prefs.model)) : "";
    effortButton.textContent = prefs.effort ?? "";
    modelButton.disabled = effortButton.disabled = !options.setPrefs;
  };
  const choose = async (changes: Prefs) => {
    const result = await options.setPrefs!(changes);
    note.textContent = result.error ?? "";
    drawPrefs();
    drawRings();
  };
  modelButton.addEventListener("click", () => {
    const current = options.prefs?.()?.model;
    void models().then((list) => menu(modelButton, list.map((m) => ({ label: m.label, on: Boolean(current) && modelName(current).split(" ")[0] === m.value, pick: () => void choose({ model: m.value }) }))));
  });
  effortButton.addEventListener("click", () => {
    const current = options.prefs?.()?.effort;
    menu(effortButton, EFFORTS.map((e) => ({ label: e, on: current === e, pick: () => void choose({ effort: e }) })));
  });
  drawPrefs();
  const rings = el("span.rings");
  let lastUsage: Usage | undefined;
  const drawRings = () => rings.replaceChildren(...miniRings(lastUsage ?? { windows: [], costUsd: 0, error: "the daemon is not reachable" }, options.prefs?.()?.model));
  const refreshRings = () =>
    usage()
      .then((data) => ((lastUsage = data), drawRings()))
      .catch(() => ((lastUsage = undefined), drawRings()));
  if (!options.mono) {
    void refreshRings();
    setInterval(() => void refreshRings(), 60_000);
    window.addEventListener("pai:prefs", () => void refreshRings());
  }
  const foot = options.mono
    ? el("div.compose-foot", {}, el("span.dim", {}, options.foot?.() ?? ""), el("span.grow"), note, el("span.dim", {}, "enter to send · shift+enter newline"))
    : el(
        "div.compose-foot",
        {},
        el("button.compose-tool", { title: "attach an image (or paste one)", onclick: () => picker.click() }, icon("paperclip", 15)),
        modelButton,
        effortButton,
        options.extra,
        rings,
        el("span.grow"),
        note,
        el("button.iconbtn.compose-send", { title: "send (enter)", onclick: () => void submit() }, icon("enter", 15)),
      );
  const node = el(
    "footer.compose",
    { class: `compose ${options.mono ? "tui-compose" : "chat-compose"}` },
    pinned,
    mentions,
    picker,
    el("div.compose-row", {}, options.mono ? el("span.prompt-char", {}, "❯") : undefined, input),
    foot,
  );

  // What he typed last time and never sent, chips and all, put back in order.
  if (draftKey)
    void loadDraft(draftKey).then((stored) => {
      if (!stored.length || input.textContent?.trim() || input.querySelector(".inline-chip")) return;
      for (const part of stored) {
        if (part.kind === "image") input.append(chipNode({ kind: "image", attachment: { media_type: part.media_type, data: part.data, preview: part.preview } }));
        else if (part.kind === "paste") input.append(chipNode({ kind: "text", text: part.text }));
        else for (const [i, line] of part.text.split("\n").entries()) {
          if (i) input.append(el("br"));
          if (line) input.append(document.createTextNode(line));
        }
      }
      settle();
    });

  return {
    node,
    input,
    note,
    pin(content, onDismiss) {
      dismissPin = undefined;
      if (!content) {
        pinned.hidden = true;
        pinned.replaceChildren();
        return;
      }
      dismissPin = () => {
        this.pin(undefined);
        onDismiss?.();
      };
      pinned.replaceChildren(content, el("button.iconbtn.slim", { title: "not answering this (esc)", onclick: dismissPin }, icon("x", 11)));
      pinned.hidden = false;
      input.focus();
    },
    disable(reason) {
      input.setAttribute("contenteditable", reason ? "false" : PLAINTEXT_EDITABLE ? "plaintext-only" : "true");
      input.classList.toggle("disabled", Boolean(reason));
      input.dataset.placeholder = reason ?? options.placeholder;
      settle();
    },
    placeholder(text) {
      if (input.getAttribute("contenteditable") !== "false") input.dataset.placeholder = text ?? options.placeholder;
    },
    focus: () => input.focus(),
    refreshPrefs: () => (drawPrefs(), drawRings()),
  };
}
