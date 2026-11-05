<script lang="ts">
  import type { Palette } from "@desk/core";
  import { Pencil, Trash2 } from "lucide-svelte";
  import { isCustomId } from "../../theme/custom";
  import ConfirmButton from "../../ui/ConfirmButton.svelte";

  /** A palette or a theme as a small picture of the app: click puts it on, the pencil opens it in the editor. */
  let { palette, on, onpick, onedit, ondelete }: { palette: Palette; on: boolean; onpick: () => void; onedit: () => void; ondelete: () => void } = $props();

  const LINES = [46, 70, 58, 80, 40];
  const CORNER = "grid size-6 place-items-center rounded-xs bg-surface text-ink-45 shadow-card transition-colors hover:text-ink";
  const custom = $derived(isCustomId(palette.id));
  const [bg, panel, line, ink, accent] = $derived(palette.swatch);
</script>

<div class="group relative min-w-0">
  <button
    type="button"
    role="radio"
    aria-checked={on}
    class="flex w-full flex-col gap-1.5 rounded-md border-2 p-1 text-left text-[12px] transition-colors {on ? 'border-accent text-ink' : 'border-transparent text-ink-45 hover:border-line'}"
    onclick={onpick}
  >
    <span class="flex h-14 overflow-hidden rounded-sm border" style="background:{bg};border-color:{line}">
      <span class="w-1/4" style="background:{panel}"></span>
      <span class="flex flex-1 flex-col justify-center gap-1 px-2">
        {#each LINES as width, i (i)}<span class="h-1 rounded-full" style="background:{i % 2 ? accent : ink};width:{width}%;opacity:{i % 2 ? 0.9 : 0.35}"></span>{/each}
      </span>
    </span>
    <span class="truncate px-0.5">{palette.name}</span>
  </button>
  <div class="absolute top-2 right-2 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 max-md:opacity-100">
    <button type="button" class={CORNER} aria-label="{custom ? 'Edit' : 'Customize'} {palette.name}" onclick={onedit}><Pencil size={13} /></button>
    {#if custom}<ConfirmButton class="{CORNER} w-auto min-w-6 px-1 text-[11px]" confirm="Delete" onconfirm={ondelete}><Trash2 size={13} /></ConfirmButton>{/if}
  </div>
</div>
