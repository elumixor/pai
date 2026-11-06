<script lang="ts">
  import { api } from "../api";
  import { dayLabel, dayOf } from "../format";
  import type { InboxEntry } from "../stores/inbox.svelte";
  import TriageEntry from "./TriageEntry.svelte";

  /** What triage acted on, by day. What it set aside stays behind the count in General's chat. */
  let { onclose }: { onclose: () => void } = $props();

  let items = $state<readonly InboxEntry[] | undefined>();

  $effect(() => void api.triaged().then(({ items: found }) => (items = found), () => (items = [])));

  const days = $derived.by(() => {
    const out: { key: string; title: string; items: InboxEntry[] }[] = [];
    for (const e of items ?? []) {
      const key = dayOf(e.at);
      if (out.at(-1)?.key !== key) out.push({ key, title: dayLabel(e.at), items: [] });
      out.at(-1)!.items.push(e);
    }
    return out;
  });
</script>

{#if !items}
  <p class="m-0 px-2 py-3 text-[13px] text-ink-45">Loading…</p>
{:else if !items.length}
  <p class="m-0 px-2 py-3 text-[13px] text-ink-45">Nothing needed acting on.</p>
{:else}
  <div class="max-h-[60vh] overflow-y-auto">
    {#each days as day (day.key)}
      <h3 class="m-0 flex h-6 items-center px-2 text-[12px] font-medium text-ink-45">{day.title}</h3>
      <ul class="m-0 list-none p-0">{#each day.items as e (e.id)}<TriageEntry {e} {onclose} />{/each}</ul>
    {/each}
  </div>
{/if}
