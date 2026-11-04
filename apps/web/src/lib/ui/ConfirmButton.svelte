<script lang="ts">
  import type { Snippet } from "svelte";

  /** A button for what cannot be undone: the first press arms it, the second does it, and leaving it disarms. */
  const ARMED_MS = 4000;
  let { confirm = "Confirm", disabled = false, class: extra = "", onconfirm, children }: { confirm?: string; disabled?: boolean; class?: string; onconfirm: () => void; children: Snippet } = $props();
  let armed = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  function disarm() {
    clearTimeout(timer);
    armed = false;
  }
  function press() {
    if (armed) {
      disarm();
      onconfirm();
      return;
    }
    armed = true;
    timer = setTimeout(disarm, ARMED_MS);
  }
  $effect(() => () => clearTimeout(timer));
</script>

<button type="button" {disabled} class="{extra} {armed ? 'font-medium text-hot' : ''}" onclick={press} onblur={disarm}>
  {#if armed}{confirm}{:else}{@render children()}{/if}
</button>
