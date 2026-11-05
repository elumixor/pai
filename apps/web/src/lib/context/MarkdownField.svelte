<script lang="ts">
  import { untrack } from "svelte";
  import { TEXTAREA } from "../settings/controls";

  /**
   * A Markdown file, edited in place and saved as it is typed. Rich by default, but a file the rich view would rewrite
   * (an import line, a tag) opens as its source instead, and nothing is written until someone actually changes it.
   */
  const SAVE_AFTER_MS = 600;
  let { value, readonly = false, save, label, onsaved }: { value: string; readonly?: boolean; save?: (text: string) => Promise<string | undefined>; label: string; onsaved?: () => void } = $props();

  const start = untrack(() => value);

  let text = $state(start);
  let note = $state("");
  let failed = $state(false);
  let saved = start;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function write() {
    clearTimeout(timer);
    if (!save || text === saved) return;
    const sending = text;
    const error = await save(sending);
    failed = Boolean(error);
    note = error ?? "Saved";
    if (!error) {
      saved = sending;
      onsaved?.();
    }
  }
  function edited(next: string) {
    text = next;
    clearTimeout(timer);
    timer = setTimeout(() => void write(), SAVE_AFTER_MS);
  }
  $effect(() => () => void write());
</script>

<div class="flex min-h-0 flex-1 flex-col gap-2">
  <div class="flex min-h-5 items-center gap-3 text-[12px]">
    <span class="min-w-0 flex-1 truncate {failed ? 'text-hot' : 'text-ink-45'}" role="status">{note}</span>
  </div>
  <textarea class="{TEXTAREA} min-h-[320px] flex-1 resize-none font-mono" aria-label={label} spellcheck="false" {readonly} value={text} oninput={(event) => edited(event.currentTarget.value)}></textarea>
</div>
