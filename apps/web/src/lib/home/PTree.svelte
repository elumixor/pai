<script lang="ts">
  import { untrack } from "svelte";
  import { recall, remember } from "../storage";
  import Icon from "../ui/Icon.svelte";
  import type { TreeRow } from "./tree";

  /**
   * The tree's rows: an icon each (a spinner in its place while it works), the name, then a hand with how many
   * decisions wait on him in it. Only the chevron folds a node; the row itself opens it. A thread that finished turns
   * into a check for a moment and goes. Folds are his arrangement of the tree, kept across reloads.
   */
  let { rows, onopen, arm }: { rows: readonly TreeRow[]; onopen: (id: string) => void; arm?: (id: string) => ((node: HTMLElement) => () => void) | undefined } = $props();

  const DONE_SHOWN_MS = 1400;
  const FOLD_KEY = "pai.tree.folded";
  let shut = $state(new Set<string>(recall<string[]>(FOLD_KEY, [])));
  /** Threads that just finished, with the row they stood after, kept for one more moment. */
  let leaving = $state<{ row: TreeRow; after: string | undefined; until: number }[]>([]);
  let last: readonly TreeRow[] = [];
  let seenOnce = false;
  const before = new Set<string>();

  $effect(() => {
    const ids = new Set(rows.map((r) => r.id));
    const now = Date.now();
    const keep = untrack(() => leaving).filter((l) => !ids.has(l.row.id) && l.until > now);
    if (last.length)
      last.forEach((row, i) => {
        if (row.thread && !ids.has(row.id) && !keep.some((l) => l.row.id === row.id))
          keep.push({ row, after: last.slice(0, i).reverse().find((r) => ids.has(r.id))?.id, until: now + DONE_SHOWN_MS });
      });
    last = rows;
    leaving = keep;
    const timer = keep.length ? setTimeout(() => (leaving = leaving.filter((l) => l.until > Date.now())), DONE_SHOWN_MS + 200) : undefined;
    return () => clearTimeout(timer);
  });

  const merged = $derived.by(() => {
    const out: TreeRow[] = [];
    const byAfter = new Map<string | undefined, TreeRow[]>();
    for (const item of leaving) byAfter.set(item.after, [...(byAfter.get(item.after) ?? []), { ...item.row, done: true }]);
    out.push(...(byAfter.get(undefined) ?? []));
    for (const row of rows) {
      out.push(row);
      out.push(...(byAfter.get(row.id) ?? []));
    }
    return out;
  });

  /** What is drawn: everything except what sits under a folded row — unless the selection is in there. */
  const visible = $derived.by(() => {
    const kids = merged.map((row, i) => (merged[i + 1]?.depth ?? -1) > row.depth);
    const open = merged.map((row, i) => {
      if (!shut.has(row.id) || !kids[i]) return true;
      for (let j = i + 1; j < merged.length && merged[j]!.depth > row.depth; j += 1) if (merged[j]!.on) return true;
      return false;
    });
    const hidden = merged.map(() => false);
    for (let i = 0; i < merged.length; i += 1) {
      if (open[i] && !hidden[i]) continue;
      for (let j = i + 1; j < merged.length && merged[j]!.depth > merged[i]!.depth; j += 1) hidden[j] = true;
    }
    return merged.map((row, i) => ({ row, kids: kids[i]!, open: open[i]! })).filter((_, i) => !hidden[i]);
  });

  function toggle(id: string) {
    const next = new Set(shut);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    shut = next;
    remember(FOLD_KEY, JSON.stringify([...next]));
  }

  /** A row that was not there a draw ago comes in; the first draw lets everything stand. */
  function enter(node: HTMLElement, id: string) {
    if (seenOnce && !before.has(id)) {
      node.classList.add("fresh");
      setTimeout(() => node.classList.remove("fresh"), 400);
    }
    before.add(id);
    queueMicrotask(() => (seenOnce = true));
  }
  const noArm = () => () => {};
</script>

<div class="ptree">
  {#each visible as { row, kids, open } (`${row.id}${row.done ? ":done" : ""}`)}
    <button
      class="ptree-row"
      class:on={row.on}
      class:done={row.done}
      class:inert={row.inert}
      class:waiting={row.waiting > 0}
      style="--depth: {row.depth}"
      title={arm && !row.inert && !row.id.includes(":") && row.id !== "pai" ? undefined : row.title}
      onclick={() => !row.inert && !row.done && onopen(row.id)}
      use:enter={row.id}
      {@attach (!row.inert && !row.done && arm?.(row.id)) || noArm()}
    >
      {#if kids}
        <span class="ptree-fold" class:open role="button" tabindex="-1" title={open ? "fold" : "unfold"} onclick={(event) => (event.stopPropagation(), toggle(row.id))} onkeydown={() => {}}><Icon name="chevron" size={9} /></span>
      {:else}
        <span class="ptree-fold empty"></span>
      {/if}
      <span class="ptree-name">
        {#if row.done}<Icon name="check" size={14} />{:else if row.working}<span class="spinner"></span>{:else}<Icon name={row.icon} size={14} />{/if}
        <span class="label">{row.label}</span>
      </span>
      {#if row.waiting && !row.done}<span class="ptree-hand"><Icon name="hand" size={12} /><span>{row.waiting}</span></span>{/if}
    </button>
  {:else}
    <p class="ptree-empty">Nothing running.</p>
  {/each}
</div>
