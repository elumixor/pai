<script lang="ts">
  import { Check, Plug, TriangleAlert } from "lucide-svelte";
  import { api } from "../api";
  import type { ConnectorSummary } from "../types";
  import AutoSend from "./AutoSend.svelte";
  import ConnectorSheet from "./ConnectorSheet.svelte";
  import { ERROR, SKELETON } from "./controls";

  /** The outside channels and capabilities as a grid of tiles; a tile opens everything about that connector. */
  const SKELETON_TILES = [0, 1, 2, 3];
  const GRID = "grid grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-x-2 gap-y-4";
  let connectors = $state<ConnectorSummary[] | undefined>();
  let error = $state("");
  let open = $state<ConnectorSummary | undefined>();
  const load = () => api.connectors().then((list) => (connectors = [...list].sort((a, b) => Number(b.connected) - Number(a.connected))), (e: Error) => (error = e.message));
  $effect(() => void load());
  function closed() {
    open = undefined;
    void load();
  }
</script>

{#if error}
  <p class={ERROR} role="alert">{error}</p>
{:else if !connectors}
  <div class={GRID} aria-hidden="true">
    {#each SKELETON_TILES as i (i)}
      <div class="flex flex-col items-center gap-2 p-1.5">
        <div class="size-16 rounded-[14px] {SKELETON}"></div>
        <div class="h-3 w-12 {SKELETON}"></div>
      </div>
    {/each}
  </div>
{:else if !connectors.length}
  <p class="m-0 text-[13px] text-ink-45">No connectors on this pai.</p>
{:else}
  <div class={GRID} data-testid="connectors">
    {#each connectors as c (c.name)}
      <button type="button" class="group flex min-w-0 flex-col items-center gap-2 p-1.5" onclick={() => (open = c)}>
        <span class="relative block size-16 transition-transform group-active:scale-95">
          <span class="grid size-full place-items-center overflow-hidden rounded-[14px] bg-white p-2.5 text-ink-45 shadow-md transition-shadow group-hover:shadow-lg {c.enabled ? '' : 'opacity-40 grayscale'}">
            {#if c.icon}<img src={c.icon} alt="" class="size-full object-contain" />{:else}<Plug size={26} />{/if}
          </span>
          {#if c.needsAction}
            <span class="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full bg-warn text-surface ring-2 ring-surface" role="img" aria-label="Needs attention"><TriangleAlert size={12} /></span>
          {:else if c.enabled}
            <span class="absolute -top-1 -right-1 grid size-4 place-items-center rounded-full bg-white text-[var(--ok,#16a34a)] shadow-sm" role="img" aria-label="Working"><Check size={10} strokeWidth={2.5} /></span>
          {/if}
        </span>
        <span class="w-full truncate text-center text-[13px] {c.enabled ? '' : 'text-ink-45'}">{c.title}</span>
      </button>
    {/each}
  </div>
{/if}

<AutoSend {connectors} />

{#if open}
  <ConnectorSheet summary={open} onclose={closed} />
{/if}
