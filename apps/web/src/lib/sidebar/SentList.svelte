<script lang="ts">
  import { api } from "../api";
  import { ago } from "../format";

  /** What agents did outside: sends, posts, writes in signed-in sites, with what each tool said came of it. */
  type Row = Awaited<ReturnType<typeof api.sent>>[number];
  const SAID: Record<Row["outcome"], string> = { verified: "Sent, read back", unverified: "Sent, not confirmed", not_sent: "Did not go", done: "Done", running: "Running…" };

  let rows = $state<readonly Row[] | undefined>();
  $effect(() => void api.sent().then((found) => (rows = found), () => (rows = [])));
</script>

{#if !rows}
  <p class="m-0 px-2 py-3 text-[13px] text-ink-45">Loading…</p>
{:else if !rows.length}
  <p class="m-0 px-2 py-3 text-[13px] text-ink-45">What agents send shows here.</p>
{:else}
  <ul class="m-0 max-h-[60vh] list-none overflow-y-auto p-0">
    {#each rows as row (row.id)}
      <li class="rounded-sm px-2 py-1.5 hover:bg-ink-5">
        <span class="line-clamp-2 text-[13px]">{row.summary || row.tool}</span>
        <span class="block text-[12px] {row.outcome === 'not_sent' ? 'text-hot' : 'text-ink-45'}">{SAID[row.outcome]}{row.agent ? ` · ${row.agent}` : ""} · {ago(row.ts)}</span>
      </li>
    {/each}
  </ul>
{/if}
