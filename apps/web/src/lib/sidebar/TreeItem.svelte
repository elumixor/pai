<script lang="ts">
  import { ChevronRight, Hand, Plus } from "lucide-svelte";
  import { href } from "../router.svelte";
  import { sidebar } from "./state.svelte";
  import { type TreeNode, waitingIn, workingIn } from "./tree";
  import TreeItem from "./TreeItem.svelte";

  /**
   * One row of the tree, Keep's: the chevron takes the icon's place when pointed at, the row opens the thread, a
   * thread's `+` starts one under it. Folded, a row says what waits and what works below it. Long lists show a batch
   * at a time, the open row always among them.
   */
  let { node, depth = 0, active, onnew }: { node: TreeNode; depth?: number; active?: string; onnew: (parent: string) => void } = $props();

  const BATCH = 10;
  let limit = $state(BATCH);
  const expanded = $derived(sidebar.expanded.has(node.id));
  const openable = $derived(node.children.length > 0);
  const on = $derived(active === node.id);
  const thread = $derived(node.id.startsWith("thread:") ? node.id.slice("thread:".length) : undefined);
  const link = $derived(thread ? href({ name: "thread", param: thread }) : href({ name: "chat", param: node.id.slice("agent:".length) }));
  const waiting = $derived(expanded ? node.waiting : waitingIn(node));
  const working = $derived(node.working || (!expanded && workingIn(node)));
  const has = (of: TreeNode, id: string): boolean => of.id === id || of.children.some((c) => has(c, id));
  const shown = $derived.by(() => {
    const at = active ? node.children.findIndex((c) => has(c, active)) : -1;
    return node.children.slice(0, Math.max(limit, at + 1));
  });

  /** j/k and the arrows walk the rows; l/→ unfolds, h/← folds or goes up to the parent. */
  function onkey(event: KeyboardEvent) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const links = [...((event.currentTarget as HTMLElement).closest('[role="tree"]')?.querySelectorAll<HTMLElement>("[data-tree-id] a") ?? [])];
    const at = links.indexOf(event.currentTarget as HTMLElement);
    if (event.key === "ArrowDown" || event.key === "j") links[at + 1]?.focus();
    else if (event.key === "ArrowUp" || event.key === "k") links[at - 1]?.focus();
    else if ((event.key === "ArrowRight" || event.key === "l") && openable) sidebar.set(node.id, true);
    else if (event.key === "ArrowLeft" || event.key === "h") {
      if (openable && expanded) sidebar.set(node.id, false);
      else links.slice(0, at).reverse().find((l) => Number(l.dataset.depth) < depth)?.focus();
    } else return;
    event.preventDefault();
  }
</script>

<div role="treeitem" data-tree-id={node.id} aria-selected={on} aria-expanded={openable ? expanded : undefined} tabindex="-1" class="group relative">
  <div
    class="relative flex h-7 items-center gap-0.5 rounded-sm pr-1 transition-colors has-[a:focus-visible]:text-ink {on ? 'bg-ink-10 font-medium text-ink' : 'text-ink-70 hover:bg-ink-5 hover:text-ink has-[a:focus-visible]:bg-ink-10'}"
    style="padding-left: {depth * 12 + 6}px"
  >
    {#if openable}
      <button
        class="absolute top-1/2 z-10 grid size-5 -translate-y-1/2 place-items-center rounded-xs text-ink-45 opacity-0 transition-opacity hover:bg-ink-10 hover:text-ink group-hover:opacity-100 group-focus-within:opacity-100 max-md:opacity-100"
        style="left: {depth * 12 + 4}px"
        aria-label={expanded ? "Collapse" : "Expand"}
        onclick={() => sidebar.set(node.id, !expanded)}
      >
        <ChevronRight size={14} class="transition-transform {expanded ? 'rotate-90' : ''}" />
      </button>
    {/if}
    <a href={link} title={node.hint} data-depth={depth} class="flex min-w-0 flex-1 items-center gap-2 self-stretch outline-none" onkeydown={onkey} onclick={() => sidebar.settle()}>
      <span class="grid w-4 shrink-0 place-items-center transition-opacity {openable ? 'group-hover:opacity-0 group-focus-within:opacity-0 max-md:opacity-0' : ''}">
        {#if working}<span class="tree-spinner"></span>{:else}<node.icon size={16} class="text-ink-45" />{/if}
      </span>
      <span class="min-w-0 flex-1 truncate">{node.label}</span>
      {#if waiting}<span class="inline-flex shrink-0 items-center gap-0.5 text-[12px] font-medium text-hand tabular-nums"><Hand size={12} />{waiting}</span>{/if}
    </a>
    {#if thread}
      <div class="flex items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 max-md:opacity-100">
        <button class="grid size-6 place-items-center rounded-xs text-ink-45 hover:bg-ink-10 hover:text-ink" aria-label="New thread under this one" title="New thread under this one" onclick={() => onnew(thread)}>
          <Plus size={16} />
        </button>
      </div>
    {/if}
  </div>
</div>
{#if expanded}
  {#each shown as child (child.id)}
    <TreeItem node={child} depth={depth + 1} {active} {onnew} />
  {/each}
  {#if shown.length < node.children.length}
    <button class="flex h-7 w-full items-center rounded-sm text-[13px] text-ink-45 transition-colors hover:bg-ink-5 hover:text-ink" style="padding-left: {(depth + 1) * 12 + 30}px" onclick={() => (limit = shown.length + BATCH)}>
      {node.children.length - shown.length} more
    </button>
  {/if}
{/if}
