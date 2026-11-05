<script lang="ts">
  import type { Snippet } from "svelte";

  /** A popup's two panes: the list on the left, what is open on the right. On a phone one shows at a time. */
  let { detailOpen, list, detail }: { detailOpen: boolean; list: Snippet; detail: Snippet } = $props();
</script>

<div class="min-h-0 w-[320px] shrink-0 overflow-y-auto border-r border-line py-2 max-md:w-full max-md:border-r-0 {detailOpen ? 'max-md:hidden' : ''}">{@render list()}</div>
<div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto {detailOpen ? '' : 'max-md:hidden'}">{@render detail()}</div>
