<script lang="ts">
  import type { RoutineEvent } from "../types";
  import { PILL } from "./controls";
  import { eventIcon } from "./routines";

  /** An event by the name a person knows it by; a kind not in the catalog, such as one from a connector that is off, reads as itself. */
  let { kind, catalog }: { kind: string; catalog: readonly RoutineEvent[] } = $props();
  const event = $derived(catalog.find((e) => e.kind === kind));
  const icon = $derived(eventIcon(event));
</script>

<span class={PILL}>
  {#if typeof icon === "string"}
    <img src={icon} alt="" class="size-3.5 shrink-0 rounded-xs object-contain" />
  {:else}
    {@const Icon = icon}
    <span class="text-ink-45"><Icon size={14} /></span>
  {/if}
  <span class="truncate">{event?.title ?? kind}</span>
</span>
