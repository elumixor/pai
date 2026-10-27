<script lang="ts">
  import type { Snippet } from "svelte";

  /**
   * A modal sheet in the page's style: it and its backdrop fade in, and fade out before it is gone — on Escape, a
   * click outside, or the owner's own close.
   */
  let { onclose, class: extra = "", children }: { onclose: () => void; class?: string; children: Snippet } = $props();
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
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog
  class="sheet {extra}"
  class:closing
  bind:this={box}
  oncancel={(event) => (event.preventDefault(), close())}
  onclick={(event) => event.target === box && close()}
>
  {@render children()}
</dialog>
