<script lang="ts">
  import { menuKey } from "@desk/core";
  import { filterItems, groupItems, ItemList, type ListItem } from "@desk/core/palette";
  import { tick, untrack } from "svelte";
  import type { RoutineEvent } from "../types";
  import { INPUT } from "./controls";
  import EventPill from "./EventPill.svelte";
  import { eventIcon } from "./routines";

  /**
   * Finding an event by name, in the flow of the sheet: a popover portals to the body, which paints under a modal
   * dialog. Once one is picked it is a pill, and pressing the pill brings the list back.
   */
  let { value, catalog, onpick }: { value: string; catalog: readonly RoutineEvent[]; onpick: (kind: string) => void } = $props();
  let listing = $state(untrack(() => !value));
  let query = $state("");
  let selected = $state(0);
  let input = $state<HTMLInputElement>();

  const items = $derived(catalog.map((e): ListItem => ({ key: e.kind, label: e.title, group: e.sourceTitle, keywords: `${e.kind} ${e.description}`, icon: eventIcon(e) })));
  const shown = $derived(groupItems(filterItems(items, query)));

  function pick(item: ListItem) {
    listing = false;
    query = "";
    onpick(item.key);
  }
  async function reopen() {
    listing = true;
    selected = 0;
    await tick();
    input?.focus();
  }
  function keydown(event: KeyboardEvent) {
    const key = menuKey(event);
    if (key === "ArrowDown" || key === "ArrowUp") {
      event.preventDefault();
      if (shown.length) selected = (selected + (key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length;
    } else if (key === "Enter") {
      event.preventDefault();
      const item = shown[selected];
      if (item) pick(item);
    } else if (key === "Escape" && value) {
      // The list closes; the sheet stays. Without preventDefault the same key would cancel the dialog too.
      event.preventDefault();
      listing = false;
    }
  }
</script>

{#if listing}
  <div class="space-y-1.5">
    <input bind:this={input} bind:value={query} class={INPUT} placeholder="Find an event" aria-label="Find an event" onkeydown={keydown} oninput={() => (selected = 0)} onblur={() => value && (listing = false)} />
    <div class="max-h-56 overflow-y-auto rounded-sm border border-line p-1">
      <ItemList items={shown} bind:selected onpick={pick} dense />
    </div>
  </div>
{:else}
  <button type="button" class="block max-w-full rounded-sm" aria-label="Change event" onclick={reopen}><EventPill kind={value} {catalog} /></button>
{/if}
