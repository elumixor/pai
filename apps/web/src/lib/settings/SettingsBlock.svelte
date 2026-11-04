<script lang="ts">
  import type { Snippet } from "svelte";

  /** One section of the settings dialog, as Keep draws its own: a title over a rule, a line when it needs one, the controls. */
  let { title, about, children }: { title: string; about?: string; children: Snippet } = $props();
</script>

<section class="space-y-3">
  <div>
    <h3 class="m-0 border-b border-line pb-2 text-[14px] font-medium">{title}</h3>
    {#if about}<p class="mt-2 mb-0 text-[13px] text-ink-45">{about}</p>{/if}
  </div>
  {@render children()}
</section>
