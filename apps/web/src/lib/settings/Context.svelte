<script lang="ts">
  import { api } from "../api";
  import type { ContextItem } from "../types";
  import ContextSheet from "./ContextSheet.svelte";
  import { BLOCK_TITLE, ERROR, ROW, ROW_BUTTON, SKELETON } from "./controls";

  /** What every session is given, except what a connector adds: that is on the connector's own sheet. */
  const FIRST = ["Persona", "Memory", "Global"];
  const rank = (name: string) => (FIRST.includes(name) ? FIRST.indexOf(name) : FIRST.length);
  const BUILT_IN = "Built-in";

  interface Row {
    readonly title: string;
    readonly note: string;
    readonly items: readonly ContextItem[];
  }

  let items = $state<ContextItem[] | undefined>();
  let error = $state("");
  let open = $state<Row | undefined>();
  const load = () => api.context().then((d) => (items = d.items.filter((i) => !i.connector)), (e: Error) => (error = e.message));
  $effect(() => void load());

  const rowOf = (item: ContextItem): Row => ({ title: item.name, note: item.description, items: [item] });
  const builtIn = $derived(items?.filter((i) => i.kind === "instruction" && !i.editable) ?? []);
  const groups = $derived.by(() => {
    const all = items ?? [];
    const written = all.filter((i) => i.kind === "memory" || (i.kind === "instruction" && i.editable)).toSorted((a, b) => rank(a.name) - rank(b.name));
    const instructions = [...written.map(rowOf), ...(builtIn.length ? [{ title: BUILT_IN, note: "", items: builtIn }] : [])];
    const skills = all.filter((i) => i.kind === "skill").map(rowOf);
    const tools = all.filter((i) => i.kind === "tool").map((item) => ({ ...rowOf(item), note: item.tools?.length ? String(item.tools.length) : item.description }));
    return [
      { title: "Instructions", rows: instructions },
      { title: "Skills", rows: skills },
      { title: "Tools", rows: tools },
    ].filter((g) => g.rows.length);
  });
  function closed() {
    open = undefined;
    void load();
  }
</script>

{#if error}
  <p class={ERROR} role="alert">{error}</p>
{:else if !items}
  <div class="space-y-2" aria-hidden="true">
    {#each [0, 1, 2] as i (i)}<div class="h-8 {SKELETON}"></div>{/each}
  </div>
{:else}
  <div class="space-y-4" data-testid="skills">
    {#each groups as group (group.title)}
      <div>
        <h4 class={BLOCK_TITLE}>{group.title}</h4>
        <ul class="m-0 list-none p-0">
          {#each group.rows as row (row.title)}
            <li class="border-b border-line last:border-b-0">
              <button type="button" class="{ROW} rounded-sm px-1 {ROW_BUTTON}" onclick={() => (open = row)}>
                <span class="w-2/5 shrink-0 truncate">{row.title}</span>
                <span class="min-w-0 flex-1 truncate text-[12px] text-ink-45">{row.note}</span>
              </button>
            </li>
          {/each}
        </ul>
      </div>
    {/each}
  </div>
{/if}

{#if open}
  <ContextSheet title={open.title} items={open.items} onclose={closed} />
{/if}
