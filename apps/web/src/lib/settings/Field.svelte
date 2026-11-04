<script lang="ts">
  import type { Snippet } from "svelte";
  import { ERROR } from "./controls";

  /** A labelled control with what went wrong beneath it. `group` is for a control that is not one input, such as a choice of buttons. */
  let { label, hint, error, group = false, children }: { label: string; hint?: string; error?: string; group?: boolean; children: Snippet } = $props();
</script>

{#snippet caption()}
  <span class="block text-[12px] text-ink-45">{label}{#if hint}<span class="text-ink-30"> · {hint}</span>{/if}</span>
{/snippet}

<div class="space-y-1.5">
  {#if group}
    <div class="space-y-1.5" role="group" aria-label={label}>
      {@render caption()}
      {@render children()}
    </div>
  {:else}
    <label class="block space-y-1.5">
      {@render caption()}
      {@render children()}
    </label>
  {/if}
  {#if error}<p class={ERROR} role="alert">{error}</p>{/if}
</div>
