<script lang="ts">
  import { DESK_DOMAIN } from "@desk/core";
  import { ChevronRight, CircleCheck, FolderGit2, Hand, Plus } from "lucide-svelte";
  import { auth } from "../auth.svelte";
  import { desk } from "../desk.svelte";
  import { href } from "../router.svelte";
  import { menus } from "../ui/menu-state.svelte";
  import { mover } from "./move.svelte";
  import { selection, sidebar } from "./state.svelte";
  import { ancestors, type TreeNode, waitingIn, workingIn } from "./tree";
  import TreeItem from "./TreeItem.svelte";

  /**
   * One row of the tree, Keep's: the chevron takes the icon's place when pointed at, the row opens the thread, a
   * thread's `+` starts one under it. ⌘/⇧-click picks rows, a drag (or `m`) puts them under another. Folded, a row says
   * what waits and what works below it. A thread in a dev project and one working on a Keep task carry a pill to each.
   */
  let { node, depth = 0, active, onnew }: { node: TreeNode; depth?: number; active?: string; onnew: (parent: string) => void } = $props();

  const BATCH = 10;
  let limit = $state(BATCH);
  let dropHere = $state(false);
  const expanded = $derived(sidebar.expanded.has(node.id));
  const openable = $derived(node.children.length > 0);
  const on = $derived(active === node.id);
  const picked = $derived(selection.has(node.id));
  const thread = $derived(node.id.startsWith("thread:") ? node.id.slice("thread:".length) : undefined);
  const link = $derived(thread ? href({ name: "thread", param: thread }) : href({ name: "chat", param: node.id.slice("agent:".length) }));
  const waiting = $derived(expanded ? node.waiting : waitingIn(node));
  const working = $derived(node.working || (!expanded && workingIn(node)));
  const has = (of: TreeNode, id: string): boolean => of.id === id || of.children.some((c) => has(c, id));
  const shown = $derived.by(() => {
    const at = active ? node.children.findIndex((c) => has(c, active)) : -1;
    return node.children.slice(0, Math.max(limit, at + 1));
  });
  const devUrl = $derived(node.project ? `https://dev.${DESK_DOMAIN}/?project=${encodeURIComponent(node.project)}${thread ? `&session=${thread}` : ""}` : undefined);
  const keepPage = (urn: string) => `${(auth.config.keepUrl ?? `https://keep.${DESK_DOMAIN}`).replace(/\/$/, "")}/p/${urn.replace(/^keep:page\//, "")}`;

  /** What a drag or a move carries from this row: the picked rows when it is one of them, else itself. */
  const carried = () => (picked ? [...selection.selected] : [node.id]);

  /** Whether the dragged rows may go under this one: a thread under a thread or an agent, an agent under an agent. */
  function accepts(ids: readonly string[]) {
    if (!node.holds) return false;
    if (node.id.startsWith("thread:") && ids.some((id) => id.startsWith("agent:"))) return false;
    // Never under itself or anything below it.
    const above = ancestors(sidebar.roots, node.id) ?? [];
    return !ids.some((id) => id === node.id || above.includes(id));
  }

  function onclick(event: MouseEvent) {
    if (event.metaKey || event.ctrlKey) {
      event.preventDefault();
      // The open row starts a ⌘ selection, as Keep's open page does.
      if (!selection.selected.size && active && active !== node.id && active !== "pai") selection.toggle(active);
      selection.toggle(node.id);
      return;
    }
    if (event.shiftKey) {
      event.preventDefault();
      selection.range(node.id, selection.anchor ?? (active && active !== "pai" ? active : null));
      return;
    }
    selection.clear();
    sidebar.settle();
  }

  function oncontextmenu(event: MouseEvent) {
    event.preventDefault();
    const ids = carried();
    menus.openContext(event.clientX, event.clientY, [
      { label: ids.length > 1 ? `Move ${ids.length} into…` : "Move into…", icon: "arrows", run: () => mover.start(ids) },
      ...(thread ? [{ label: "New thread under this one", icon: "plus" as const, run: () => onnew(thread) }] : []),
      ...(devUrl ? [{ label: `Open ${node.project} in Dev`, icon: "code" as const, run: () => window.open(devUrl, "_blank", "noopener") }] : []),
    ]);
  }

  /** j/k and the arrows walk the rows; l/→ unfolds, h/← folds or goes up; ⇧ with them picks; `m` moves. */
  function onkey(event: KeyboardEvent) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const links = [...((event.currentTarget as HTMLElement).closest('[role="tree"]')?.querySelectorAll<HTMLElement>("[data-tree-id] a[data-depth]") ?? [])];
    const at = links.indexOf(event.currentTarget as HTMLElement);
    const down = event.key === "ArrowDown" || event.key === "j" || event.key === "J";
    const up = event.key === "ArrowUp" || event.key === "k" || event.key === "K";
    if (event.shiftKey && (down || up)) {
      const next = links[at + (down ? 1 : -1)];
      if (next) {
        const id = next.closest<HTMLElement>("[data-tree-id]")!.dataset.treeId!;
        if (!selection.selected.size) selection.toggle(node.id);
        selection.range(id, selection.anchor ?? node.id);
        next.focus();
      }
    } else if (down) links[at + 1]?.focus();
    else if (up) links[at - 1]?.focus();
    else if ((event.key === "ArrowRight" || event.key === "l") && openable) sidebar.set(node.id, true);
    else if (event.key === "ArrowLeft" || event.key === "h") {
      if (openable && expanded) sidebar.set(node.id, false);
      else links.slice(0, at).reverse().find((l) => Number(l.dataset.depth) < depth)?.focus();
    } else if (event.key === "m") mover.start(carried());
    else if (event.key === "Escape" && selection.selected.size) selection.clear();
    else return;
    event.preventDefault();
  }

  function ondragstart(event: DragEvent) {
    if (!picked) selection.clear();
    selection.dragging = carried();
    event.dataTransfer?.setData("text/plain", selection.dragging.join(" "));
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  }

  function ondragover(event: DragEvent) {
    if (!selection.dragging || !accepts(selection.dragging)) return;
    event.preventDefault();
    event.stopPropagation();
    dropHere = true;
  }

  function ondrop(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    dropHere = false;
    const ids = selection.dragging;
    selection.dragging = null;
    if (!ids || !accepts(ids)) return;
    selection.clear();
    sidebar.set(node.id, true);
    void desk.move(ids, node.id);
  }
</script>

<div
  role="treeitem"
  data-tree-id={node.id}
  aria-selected={on || picked}
  aria-expanded={openable ? expanded : undefined}
  tabindex="-1"
  class="group relative"
  {ondragover}
  ondragleave={() => (dropHere = false)}
  {ondrop}
  {oncontextmenu}
>
  <div
    class="relative flex h-7 items-center gap-0.5 rounded-sm pr-1 transition-colors has-[a:focus-visible]:text-ink {on ? 'font-medium text-ink' : 'text-ink-70 hover:text-ink'} {picked && selection.last === node.id ? 'bg-accent/25 hover:bg-accent/30 has-[a:focus-visible]:bg-accent/30' : dropHere || picked ? 'bg-accent-soft hover:bg-accent/20 has-[a:focus-visible]:bg-accent/20' : on ? 'bg-ink-10' : 'hover:bg-ink-5 has-[a:focus-visible]:bg-ink-10'}"
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
    <a
      href={link}
      title={node.hint}
      data-depth={depth}
      draggable="true"
      class="flex min-w-0 flex-1 items-center gap-2 self-stretch outline-none"
      onkeydown={onkey}
      {onclick}
      {ondragstart}
      ondragend={() => (selection.dragging = null)}
    >
      <span class="grid w-4 shrink-0 place-items-center transition-opacity {openable ? 'group-hover:opacity-0 group-focus-within:opacity-0 max-md:opacity-0' : ''}">
        {#if working}<span class="tree-spinner"></span>{:else}<node.icon size={16} class="text-ink-45" />{/if}
      </span>
      <span class="min-w-0 truncate">{node.label}</span>
      {#if devUrl}
        <span
          role="link"
          tabindex="-1"
          class="-ml-0.5 inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-full px-1.5 py-1 text-[12px] leading-4 text-ink-45 hover:bg-ink-10 hover:text-ink"
          title="{node.project} in Dev"
          onclick={(e) => { e.preventDefault(); e.stopPropagation(); window.open(devUrl, "_blank", "noopener"); }}
          onkeydown={() => {}}
        ><FolderGit2 size={11} /></span>
      {/if}
      {#each node.keep ?? [] as task (task.urn)}
        <span
          role="link"
          tabindex="-1"
          class="-ml-1.5 inline-flex shrink-0 cursor-pointer items-center rounded-full px-1.5 py-1 leading-4 text-ink-45 hover:bg-ink-10 hover:text-ink"
          title={task.title ? `${task.title} in Keep` : "Keep task"}
          onclick={(e) => { e.preventDefault(); e.stopPropagation(); window.open(keepPage(task.urn), "_blank", "noopener"); }}
          onkeydown={() => {}}
        ><CircleCheck size={11} /></span>
      {/each}
      <span class="min-w-0 flex-1"></span>
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
