<script lang="ts">
  import { ArrowUp, Paperclip, X } from "lucide-svelte";
  import type { Upload } from "$lib/types";

  /** The box: text, pasted or attached pictures, Enter to send. What is typed survives a reload. */
  let { draftKey, disabled = false, onsend }: { draftKey: string; disabled?: boolean; onsend: (text: string, images: Upload[]) => Promise<boolean> } = $props();

  const KEY = $derived(`pai.draft.${draftKey}`);
  let text = $state("");
  let images = $state<(Upload & { preview: string })[]>([]);
  let input = $state<HTMLTextAreaElement>();
  let picker = $state<HTMLInputElement>();

  $effect(() => {
    try {
      text = localStorage.getItem(KEY) ?? "";
    } catch {
      text = "";
    }
  });

  function remember() {
    try {
      if (text) localStorage.setItem(KEY, text);
      else localStorage.removeItem(KEY);
    } catch (error) {
      console.warn("[composer] could not keep the draft", error);
    }
  }

  async function attach(files: Iterable<File>) {
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      images = [...images, { media_type: file.type, data: data.split(",")[1] ?? "", name: file.name, preview: data }];
    }
  }

  async function send() {
    if (disabled || (!text.trim() && !images.length)) return;
    const sent = await onsend(text, images.map(({ preview: _preview, ...upload }) => upload));
    if (!sent) return;
    text = "";
    images = [];
    remember();
    input?.focus();
  }
</script>

<form
  class="border border-line bg-surface shadow-sm focus-within:border-faint"
  onsubmit={(e) => {
    e.preventDefault();
    void send();
  }}
>
  {#if images.length}
    <div class="flex gap-2 px-3 pt-3">
      {#each images as image, index (index)}
        <div class="relative">
          <img src={image.preview} alt="" class="size-16 object-cover" />
          <button type="button" class="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full bg-ink text-bg" aria-label="Remove picture" onclick={() => (images = images.filter((_, i) => i !== index))}><X size={11} /></button>
        </div>
      {/each}
    </div>
  {/if}
  <textarea
    bind:this={input}
    bind:value={text}
    rows="1"
    class="block max-h-60 w-full resize-none bg-transparent px-4 py-3 outline-none [field-sizing:content]"
    placeholder="Message pai"
    aria-label="Message"
    oninput={remember}
    onpaste={(e) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.length) {
        e.preventDefault();
        void attach(files);
      }
    }}
    onkeydown={(e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void send();
      }
    }}
  ></textarea>
  <div class="flex items-center gap-1 px-2 pb-2">
    <input bind:this={picker} type="file" accept="image/*" multiple class="hidden" onchange={(e) => void attach(e.currentTarget.files ?? [])} />
    <button type="button" class="grid size-8 place-items-center text-muted hover:text-ink" aria-label="Attach a picture" onclick={() => picker?.click()}><Paperclip size={16} /></button>
    <button class="ml-auto grid size-8 place-items-center rounded-full bg-ink text-bg disabled:opacity-30" aria-label="Send" disabled={disabled || (!text.trim() && !images.length)}><ArrowUp size={16} /></button>
  </div>
</form>
