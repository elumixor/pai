<script lang="ts" module>
  import type { Effort, Upload } from "../types";

  /** The model and effort a conversation runs with: what was asked for, else what it runs with anyway. */
  export interface Prefs {
    readonly model?: string | null;
    readonly effort?: Effort | null;
  }

  /** What sits pinned above the box until the next message is sent or it is dismissed: a reply's quote, a question. */
  export interface Pin {
    readonly icon: "reply" | "help";
    readonly from?: string;
    readonly text: string;
    readonly onDismiss?: () => void;
  }

  export type Submit = (text: string, images: readonly Upload[]) => Promise<void> | void;
</script>

<script lang="ts">
  import type { Snippet } from "svelte";
  import { api } from "../api";
  import { desk } from "../desk.svelte";
  import { clearDraft, type DraftPart, loadDraft, saveDraft } from "../drafts";
  import { capital, modelName, sizeOf } from "../format";
  import { el, iconNode } from "../icons";
  import type { SlashCommand } from "../types";
  import Icon from "../ui/Icon.svelte";
  import { menus } from "../ui/menu-state.svelte";
  import Rings from "./Rings.svelte";

  /**
   * The message box every conversation shares: `/` at the start offers the session's slash commands, a pasted image
   * or a long paste becomes a chip right where it was dropped — one message can interleave text and attachments, in
   * order. Enter sends, shift+enter breaks the line. What he typed and did not send survives a reload, pictures too.
   */
  let {
    placeholder,
    submit,
    draftKey,
    session,
    prefs,
    setPrefs,
    extra,
    mono = false,
    foot = "",
    disabled = "",
  }: {
    placeholder: string;
    submit: Submit;
    draftKey?: string;
    /** The session whose slash commands `/` offers. */
    session?: () => string | undefined;
    prefs?: () => Prefs | undefined;
    setPrefs?: (changes: Prefs) => Promise<{ error?: string }>;
    /** A control of the host's in the foot, after the effort (pai's "new thread" switch). */
    extra?: Snippet;
    /** The terminal look: `❯`, monospace, a dim foot. */
    mono?: boolean;
    foot?: string;
    /** Why the box takes nothing now, shown in its place. */
    disabled?: string;
  } = $props();

  const FAMILIES = ["fable", "opus", "sonnet", "haiku"] as const;
  const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];
  const MAX_BYTES = 25 * 1024 * 1024;
  const UNREADABLE = /\.(zip|rar|7z|tar|gz|tgz|bz2|exe|dmg|pkg|app|iso|bin|so|dylib|dll|xls|xlsx|doc|docx|ppt|pptx|key|numbers|pages|mp4|mov|avi|mkv|mp3|wav|m4a)$/i;
  // A paste longer than this collapses into a chip instead of filling the box with raw text.
  const CHUNK_CHARS = 400;
  const CHUNK_LINES = 8;
  const PLAINTEXT = (() => {
    const probe = document.createElement("div");
    probe.contentEditable = "plaintext-only";
    return probe.contentEditable === "plaintext-only";
  })();

  interface Attachment extends Upload {
    /** A data URL for a picture's thumbnail; a document has none. */
    readonly preview: string;
    readonly size?: number;
  }
  type Chip = { kind: "image" | "file"; attachment: Attachment } | { kind: "text"; text: string };

  let input = $state<HTMLDivElement>();
  let picker = $state<HTMLInputElement>();
  let note = $state("");
  let pin = $state<Pin | null>(null);
  let shownPlaceholder = $state<string | undefined>();
  let suggestions = $state<{ label: string; hint?: string; insert: string }[]>([]);
  let active = $state(0);
  let modelButton = $state<HTMLButtonElement>();
  let effortButton = $state<HTMLButtonElement>();
  let prefsShown = $state<Prefs | undefined>();
  const chips = new WeakMap<HTMLElement, Chip>();
  let slash: SlashCommand[] | undefined;
  let menuNode: Text | undefined;
  let menuStart = -1;
  let saving: ReturnType<typeof setTimeout> | undefined;
  const storeKey = $derived(draftKey ? `pai.draft:${draftKey}` : undefined);

  $effect(() => {
    void desk.usage;
    prefsShown = prefs?.();
  });

  /** Says something else in the empty box for a while; none puts the usual words back. */
  export const setPlaceholder = (text?: string) => (shownPlaceholder = text);
  export const setNote = (text: string) => (note = text);
  export const focus = () => input?.focus();
  export const refreshPrefs = () => (prefsShown = prefs?.());
  export function setPin(next: Pin | null) {
    pin = next;
    if (next) input?.focus();
  }
  const dismissPin = () => {
    const was = pin;
    pin = null;
    was?.onDismiss?.();
  };

  /** A true-empty element is what the CSS placeholder hooks on; a stray trailing `<br>` would hide it. */
  const settle = () => {
    if (input && !input.textContent?.trim() && !input.querySelector(".inline-chip")) input.replaceChildren();
  };
  const selectionRange = () => {
    const sel = window.getSelection();
    return sel?.rangeCount && input?.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : undefined;
  };
  const endRange = () => {
    const r = document.createRange();
    r.selectNodeContents(input!);
    r.collapse(false);
    return r;
  };

  function chipNode(chip: Chip) {
    const body =
      chip.kind === "text"
        ? [iconNode("file", 11), el("span", {}, `Pasted text · ${chip.text.length.toLocaleString()} chars`)]
        : chip.kind === "image"
          ? [el("img", { src: chip.attachment.preview, alt: "" })]
          : [iconNode("file", 11), el("span", {}, `${chip.attachment.name ?? "file"} · ${sizeOf(chip.attachment.size ?? 0)}`)];
    const span = el("span", { class: `chip inline-chip ${chip.kind}`, contenteditable: "false" }, ...body);
    const remove = el("button.chip-remove", { type: "button", tabindex: -1, title: "remove", onmousedown: (e: Event) => e.preventDefault() }, iconNode("x", 10));
    remove.addEventListener("click", () => {
      span.remove();
      settle();
      input?.focus();
    });
    span.append(remove);
    chips.set(span, chip);
    return span;
  }

  /** Drops a chip at the caret (or the end), with room for the caret right after it. */
  function insertChip(chip: Chip) {
    const range = selectionRange() ?? endRange();
    range.deleteContents();
    const spacer = document.createTextNode(" ");
    range.insertNode(spacer);
    const before = document.createRange();
    before.setStartBefore(spacer);
    before.collapse(true);
    before.insertNode(chipNode(chip));
    const after = document.createRange();
    after.setStart(spacer, 1);
    after.collapse(true);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(after);
    input?.normalize();
    settle();
    input?.focus();
    keepDraft();
  }

  const refuse = (file: File) =>
    file.size > MAX_BYTES ? `${file.name} is ${sizeOf(file.size)} — the limit is ${sizeOf(MAX_BYTES)}` : !file.size ? `${file.name} is empty` : UNREADABLE.test(file.name) ? `${file.name} is a kind the model cannot read — put it in a repo and say where` : undefined;
  const readFile = (file: File) =>
    new Promise<Attachment>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => {
        const url = String(reader.result);
        resolve({ media_type: file.type, data: url.slice(url.indexOf(",") + 1), preview: file.type.startsWith("image/") ? url : "", name: file.name, size: file.size });
      };
      reader.readAsDataURL(file);
    });
  async function offer(file: File) {
    const why = refuse(file);
    if (why) return void (note = why);
    note = "";
    insertChip({ kind: file.type.startsWith("image/") ? "image" : "file", attachment: await readFile(file) });
  }

  async function paste(event: ClipboardEvent) {
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
  }

  const closeMenu = () => {
    suggestions = [];
    menuNode = undefined;
    menuStart = -1;
  };
  function pick(item: { insert: string }) {
    const node = menuNode;
    if (!node?.isConnected) return closeMenu();
    const caret = selectionRange();
    const end = caret?.collapsed && caret.startContainer === node ? caret.startOffset : node.length;
    node.textContent = `${node.textContent!.slice(0, menuStart)}${item.insert}${node.textContent!.slice(end)}`;
    const at = menuStart + item.insert.length;
    closeMenu();
    input?.focus();
    const range = document.createRange();
    range.setStart(node, at);
    range.collapse(true);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }
  // The commands are the process's own: skills, plugins, and Claude Code's built-ins that make sense off a terminal.
  async function showCommands(query: string) {
    const id = session?.();
    if (!id) return closeMenu();
    slash ??= await api.commands(id).catch(() => []);
    const q = query.toLowerCase();
    suggestions = slash
      .filter((c) => c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q))
      .sort((a, b) => Number(b.name.toLowerCase().startsWith(q)) - Number(a.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name))
      .slice(0, 10)
      .map((c) => ({ label: `/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ""}`, hint: c.description, insert: `/${c.name} ` }));
    active = 0;
  }

  function typed() {
    input?.normalize();
    settle();
    keepDraft();
    const range = selectionRange();
    const node = range?.collapsed ? range.startContainer : undefined;
    if (!node || node.nodeType !== Node.TEXT_NODE) return closeMenu();
    const text = node as Text;
    const before = text.textContent!.slice(0, range!.startOffset);
    // A command only reads as one at the very start of the message.
    if (!text.previousSibling && before.startsWith("/") && !/\s/.test(before)) {
      menuNode = text;
      menuStart = 0;
      return void showCommands(before.slice(1));
    }
    closeMenu();
  }

  /** What is in the box: the text with its pasted chunks in place, and the attachments. */
  function contents() {
    let text = "";
    const images: Upload[] = [];
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) return void (text += node.textContent ?? "");
      if (node.nodeName === "BR") return void (text += "\n");
      const chip = node instanceof HTMLElement ? chips.get(node) : undefined;
      if (chip?.kind === "image" || chip?.kind === "file") return void images.push({ media_type: chip.attachment.media_type, data: chip.attachment.data, name: chip.attachment.name });
      if (chip?.kind === "text") return void (text += chip.text);
      node.childNodes.forEach(walk);
    };
    input?.childNodes.forEach(walk);
    return { text: text.replace(/ /g, " ").trim(), images };
  }

  /** The box as draft parts, in the order he typed them, so a reload puts the chips back where they were. */
  function parts(): DraftPart[] {
    const out: DraftPart[] = [];
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) return void out.push({ kind: "text", text: node.textContent ?? "" });
      if (node.nodeName === "BR") return void out.push({ kind: "text", text: "\n" });
      const chip = node instanceof HTMLElement ? chips.get(node) : undefined;
      if (chip?.kind === "image" || chip?.kind === "file") return void out.push({ kind: "image", ...chip.attachment });
      if (chip?.kind === "text") return void out.push({ kind: "paste", text: chip.text });
      node.childNodes.forEach(walk);
    };
    input?.childNodes.forEach(walk);
    return out.filter((p) => p.kind !== "text" || p.text);
  }
  function keepDraft() {
    const key = storeKey;
    if (!key) return;
    clearTimeout(saving);
    saving = setTimeout(() => void saveDraft(key, parts()), 300);
  }

  // What he typed last time and never sent, chips and all, put back in order.
  $effect(() => {
    const key = storeKey;
    const box = input;
    if (!key || !box) return;
    void loadDraft(key).then((stored) => {
      if (!stored.length || box.textContent?.trim() || box.querySelector(".inline-chip")) return;
      for (const part of stored) {
        if (part.kind === "image") box.append(chipNode({ kind: part.preview ? "image" : "file", attachment: { media_type: part.media_type, data: part.data, preview: part.preview, name: part.name, size: part.size } }));
        else if (part.kind === "paste") box.append(chipNode({ kind: "text", text: part.text }));
        else
          for (const [i, line] of part.text.split("\n").entries()) {
            if (i) box.append(document.createElement("br"));
            if (line) box.append(document.createTextNode(line));
          }
      }
      settle();
    });
  });

  async function send() {
    if (disabled) return;
    const { text, images } = contents();
    if (!text && !images.length) return;
    input?.replaceChildren();
    settle();
    closeMenu();
    if (storeKey) void clearDraft(storeKey);
    await submit(text, images);
  }

  function keydown(event: KeyboardEvent) {
    if (suggestions.length) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        active = (active + (event.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length;
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        if (suggestions[active]) pick(suggestions[active]);
        return;
      }
      if (event.key === "Escape") return closeMenu();
    }
    if (event.key === "Escape" && pin) return dismissPin();
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void send();
    }
  }

  async function models() {
    const latest = await api.models().catch(() => ({}) as Record<string, { id: string; name: string }>);
    return FAMILIES.filter((f) => latest[f] || f !== "fable").map((f) => ({ value: f, label: latest[f]?.name.replace(/^Claude /, "") ?? capital(f) }));
  }
  async function choose(changes: Prefs) {
    const result = (await setPrefs?.(changes)) ?? {};
    note = result.error ?? "";
    refreshPrefs();
  }
  async function openModels() {
    const current = prefsShown?.model;
    const list = await models();
    if (modelButton) menus.openDropdown(modelButton, list.map((m) => ({ label: m.label, on: Boolean(current) && modelName(current).split(" ")[0] === m.value, pick: () => void choose({ model: m.value }) })));
  }
  function openEfforts() {
    const current = prefsShown?.effort;
    if (effortButton) menus.openDropdown(effortButton, EFFORTS.map((e) => ({ label: e, on: current === e, pick: () => void choose({ effort: e }) })));
  }
</script>

<footer class="compose {mono ? 'tui-compose' : 'chat-compose'}">
  {#if pin}
    <div class="compose-pin">
      <span class="ellipsis quote-pin"><Icon name={pin.icon} size={10} />{#if pin.from}<b>{pin.from}</b>:{/if} {pin.text}</span>
      <button class="iconbtn slim" title="not answering this (esc)" aria-label="Dismiss" onclick={dismissPin}><Icon name="x" size={11} /></button>
    </div>
  {/if}
  {#if suggestions.length}
    <div class="mentions">
      {#each suggestions as item, i (item.insert)}
        <button class="mention" class:active={i === active} onmousedown={(e) => (e.preventDefault(), pick(item))}><span class="label">{item.label}</span>{#if item.hint}<span class="dim ellipsis">{item.hint}</span>{/if}</button>
      {/each}
    </div>
  {/if}
  <input type="file" multiple hidden bind:this={picker} onchange={async () => {
    for (const file of picker?.files ?? []) await offer(file);
    if (picker) picker.value = "";
  }} />
  <div class="compose-row">
    {#if mono}<span class="prompt-char">❯</span>{/if}
    <div
      class="input"
      class:disabled={Boolean(disabled)}
      bind:this={input}
      contenteditable={disabled ? "false" : PLAINTEXT ? "plaintext-only" : "true"}
      role="textbox"
      tabindex="0"
      aria-multiline="true"
      aria-label="Message"
      data-placeholder={disabled || shownPlaceholder || placeholder}
      oninput={typed}
      onpaste={paste}
      onkeydown={keydown}
    ></div>
  </div>
  {#if mono}
    <div class="compose-foot"><span class="dim">{foot}</span><span class="grow"></span><span class="note">{note}</span><span class="dim">enter to send · shift+enter newline</span></div>
  {:else}
    <div class="compose-foot">
      <button class="compose-tool" title="attach a file (or paste an image)" aria-label="Attach" onclick={() => picker?.click()}><Icon name="paperclip" size={15} /></button>
      {#if prefsShown?.model}<button class="compose-tool model" title="the model this conversation runs with" bind:this={modelButton} disabled={!setPrefs} onclick={openModels}>{capital(modelName(prefsShown.model))}</button>{/if}
      {#if prefsShown?.effort}<button class="compose-tool effort" title="how hard it thinks" bind:this={effortButton} disabled={!setPrefs} onclick={openEfforts}>{prefsShown.effort}</button>{/if}
      {@render extra?.()}
      <Rings model={prefsShown?.model} />
      <span class="grow"></span>
      <span class="note">{note}</span>
      <button class="iconbtn compose-send" title="send (enter)" aria-label="Send" onclick={() => void send()}><Icon name="enter" size={15} /></button>
    </div>
  {/if}
</footer>
