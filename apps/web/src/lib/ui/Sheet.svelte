<script lang="ts">
  import { X } from "lucide-svelte";
  import type { Snippet } from "svelte";

  /**
   * A modal sheet in the page's style, above everything including the settings dialog: a native modal sits in the top
   * layer. It and its backdrop fade in, and fade out before it is gone: on Escape, a click outside, its own close
   * button, or the owner calling `close`.
   */
  let { label, onclose, head, children }: { label: string; onclose: () => void; head: Snippet; children: Snippet } = $props();
  let box = $state<HTMLDialogElement>();
  let closing = $state(false);
  const motionMs = () => (matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 200);

  $effect(() => {
    box?.showModal();
    return () => box?.open && box.close();
  });

  /** Fades, then tells the owner, which unmounts the sheet. */
  export function close() {
    if (closing) return;
    closing = true;
    setTimeout(onclose, motionMs());
  }

  // SettingsDialog closes itself on any Escape that reaches the window; the native cancel still fires without it.
  function keydown(event: KeyboardEvent) {
    if (event.key === "Escape") event.stopPropagation();
  }
</script>

<!-- A press on plain text must leave focus inside the dialog, or Escape goes past its keydown to the window. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_click_events_have_key_events, a11y_no_noninteractive_tabindex -->
<dialog
  class="sheet"
  tabindex="-1"
  aria-label={label}
  class:closing
  bind:this={box}
  onkeydown={keydown}
  oncancel={(event) => (event.preventDefault(), close())}
  onclose={close}
  onclick={(event) => event.target === box && close()}
>
  <header class="flex shrink-0 items-center gap-3 border-b border-line py-3 pr-3 pl-5 max-sm:pl-4">
    <div class="min-w-0 flex-1">{@render head()}</div>
    <button type="button" class="grid size-8 shrink-0 place-items-center rounded-sm text-ink-45 transition-colors hover:bg-ink-5 hover:text-ink" aria-label="Close" onclick={close}><X size={16} /></button>
  </header>
  <div class="min-h-0 overflow-y-auto px-5 py-4 max-sm:px-4">{@render children()}</div>
</dialog>
