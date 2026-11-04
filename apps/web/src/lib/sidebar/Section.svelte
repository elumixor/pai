<script lang="ts">
  import { ChevronRight } from "lucide-svelte";
  import { flip } from "svelte/animate";
  import { selection, sidebar } from "./state.svelte";
  import type { TreeNode } from "./tree";
  import TreeItem from "./TreeItem.svelte";

  /**
   * One group of the tree's top level: a batch of rows at a time (the open one always among them), "N more" for the
   * rest. A named group has a header that folds it, as Keep's sidebar sections do.
   */
  let { key, label, nodes, active, onnew }: { key: string; label?: string; nodes: readonly TreeNode[]; active?: string; onnew: (parent: string) => void } = $props();

  const BATCH = 10;
  let limit = $state(BATCH);
  const folded = $derived(label ? sidebar.expanded.has(`section:${key}`) : false);
  const has = (of: TreeNode, id: string): boolean => of.id === id || of.children.some((c) => has(c, id));
  const shown = $derived.by(() => {
    const at = active ? nodes.findIndex((r) => has(r, active)) : -1;
    return nodes.slice(0, Math.max(limit, at + 1));
  });
  const hidden = $derived(nodes.slice(shown.length).map((r) => r.id));
  const hiddenPicked = $derived(selection.allPicked(hidden));
  const moreKey = $derived(`more:section:${key}`);
</script>

{#if label}
  <button
    class="group/section mt-3 flex h-7 w-full items-center gap-1 rounded-sm px-2 text-[12px] font-medium text-ink-45 transition-colors hover:bg-ink-5 hover:text-ink"
    aria-expanded={!folded}
    onclick={() => {
      // Folded, it forgets how far it was listed: opened again, it shows the first batch.
      if (!folded) limit = BATCH;
      sidebar.set(`section:${key}`, !folded);
    }}
  >
    {label}
    <span class="tabular-nums text-ink-30">{nodes.length}</span>
    <ChevronRight size={12} class="opacity-0 transition group-hover/section:opacity-100 {folded ? '' : 'rotate-90'}" />
  </button>
{/if}
{#if !folded}
  {#each shown as node (node.id)}
    <div animate:flip={{ duration: 220 }}><TreeItem {node} {active} {onnew} /></div>
  {/each}
  {#if shown.length < nodes.length}
    <button
      class="flex h-7 w-full items-center rounded-sm pl-[30px] text-[13px] text-ink-45 transition-colors hover:text-ink {hiddenPicked && selection.last === moreKey ? 'bg-accent/25 hover:bg-accent/30' : hiddenPicked ? 'bg-accent-soft hover:bg-accent/20' : 'hover:bg-ink-5'}"
      data-tree-more={hidden.join(" ")}
      oncontextmenu={(e) => selection.moreMenu(e, hidden)}
      onclick={(e) => { if (!selection.more(e, hidden, moreKey, active)) limit = shown.length + BATCH; }}
    >
      {nodes.length - shown.length} more
    </button>
  {/if}
{/if}
