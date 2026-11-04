<script lang="ts">
  import { Clock, Plus } from "lucide-svelte";
  import { api } from "../api";
  import { ago } from "../format";
  import type { Routine, RoutineEvent } from "../types";
  import Switch from "../ui/Switch.svelte";
  import { ERROR, PILL, ROW, ROW_BUTTON, SKELETON } from "./controls";
  import EventPill from "./EventPill.svelte";
  import RoutineSheet from "./RoutineSheet.svelte";
  import { ACTION_LABELS, describeSchedule } from "./routines";

  /** What makes pai act on its own: one row per routine, switched in place, its sheet a press away. */
  let routines = $state<Routine[] | undefined>();
  let catalog = $state<RoutineEvent[]>([]);
  let error = $state("");
  /** The routine whose sheet is open; `null` for a new one. */
  let open = $state<Routine | null | undefined>();

  const load = () => api.routines().then((list) => (routines = list), (e: Error) => (error = e.message));
  $effect(() => {
    void load();
    void api.routineEvents().then((events) => (catalog = events), (e: Error) => (error = e.message));
  });

  const withEnabled = (id: number, enabled: boolean) => routines?.map((r) => (r.id === id ? { ...r, enabled } : r));
  async function toggle(rule: Routine, enabled: boolean) {
    routines = withEnabled(rule.id, enabled);
    const result = await api.updateRoutine(rule.id, { enabled });
    error = result.error ?? "";
    if (result.error) routines = withEnabled(rule.id, !enabled);
  }
  function closed() {
    open = undefined;
    void load();
  }
</script>

{#if error}<p class={ERROR} role="alert">{error}</p>{/if}
{#if routines}
  <ul class="m-0 list-none p-0" data-testid="routines">
    {#each routines as rule (rule.id)}
      <li class={ROW}>
        <Switch checked={rule.enabled} label="{rule.name} on" onchange={(next) => void toggle(rule, next)} />
        <button type="button" class="grid min-h-10 min-w-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_5.5rem_3.5rem] items-center gap-3 rounded-sm px-1 py-1.5 text-left max-sm:grid-cols-1 max-sm:gap-1 {ROW_BUTTON}" onclick={() => (open = rule)}>
          <span class="truncate {rule.enabled ? '' : 'text-ink-45'}">{rule.name}</span>
          <span class="min-w-0">
            {#if rule.event}
              <EventPill kind={rule.event} {catalog} />
            {:else}
              <span class={PILL}><span class="text-ink-45"><Clock size={14} /></span><span class="truncate">{describeSchedule(rule.schedule)}</span></span>
            {/if}
          </span>
          <span class="truncate text-[12px] text-ink-45 max-sm:hidden">{ACTION_LABELS[rule.action] ?? rule.action}</span>
          <span class="text-right text-[12px] text-ink-45 tabular-nums max-sm:hidden" title={rule.lastRun ? `Last ${ago(rule.lastRun)} ago` : "Never ran"}>{rule.runs}×</span>
        </button>
      </li>
    {/each}
    <li class={ROW}>
      <button type="button" class="flex min-h-10 flex-1 items-center gap-2 rounded-sm px-1 text-ink-45 hover:text-ink {ROW_BUTTON}" onclick={() => (open = null)}><Plus size={16} /> New routine</button>
    </li>
  </ul>
{:else if !error}
  <div class="space-y-2" aria-hidden="true">
    {#each [0, 1, 2] as i (i)}<div class="h-8 {SKELETON}"></div>{/each}
  </div>
{/if}

{#if open !== undefined}
  <RoutineSheet routine={open} {catalog} onclose={closed} />
{/if}
