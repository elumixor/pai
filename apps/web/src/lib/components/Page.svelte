<script lang="ts">
  import type { Snippet } from "svelte";

  let { title, children }: { title: string; children: Snippet } = $props();
</script>

<div class="h-full overflow-y-auto">
  <header class="flex h-12 items-center border-b border-line px-5 max-md:pl-12"><h1 class="font-display text-lg font-semibold">{title}</h1></header>
  <div class="mx-auto max-w-[760px] space-y-8 px-5 py-6">{@render children()}</div>
</div>
