<script lang="ts">
  import { Hand, House, LogOut, PanelLeftClose, Plus, Settings } from "lucide-svelte";
  import { auth } from "../auth.svelte";
  import { desk } from "../desk.svelte";
  import { href, navigate } from "../router.svelte";
  import MenuItem from "../ui/MenuItem.svelte";
  import Popover from "../ui/Popover.svelte";
  import Separator from "../ui/Separator.svelte";
  import { SIDEBAR_COLLAPSE, sidebar } from "./state.svelte";
  import { type TreeNode, generalWaiting } from "./tree";
  import TreeItem from "./TreeItem.svelte";

  /**
   * The sidebar, Keep's: General at the top where Keep has its workspace, every thread under it as a tree, the account
   * at the bottom. Resized by its edge, dragged shut past a point.
   */
  let { roots, active, onsettings }: { roots: readonly TreeNode[]; active?: string; onsettings: () => void } = $props();

  const ROOT_BATCH = 20;

  let limit = $state(ROOT_BATCH);
  let accountOpen = $state(false);
  const home = $derived(active === "pai");
  const waiting = $derived(generalWaiting(desk.agents, desk.sessions, desk.needs, desk.paiSession?.sessionId));
  const has = (of: TreeNode, id: string): boolean => of.id === id || of.children.some((c) => has(c, id));
  const shown = $derived.by(() => {
    const at = active ? roots.findIndex((r) => has(r, active)) : -1;
    return roots.slice(0, Math.max(limit, at + 1));
  });
  const row = "flex h-7 w-full items-center gap-2 rounded-sm px-2 text-ink-70 transition-colors hover:bg-ink-5 hover:text-ink [&>svg]:text-ink-45";
  const action = "grid size-6 place-items-center rounded-xs text-ink-45 hover:bg-ink-10 hover:text-ink";

  /** Listens on the window: collapsing unmounts this sidebar, and the same drag must still be able to bring it back. */
  function startResize(event: PointerEvent) {
    const left = (event.currentTarget as HTMLElement).parentElement!.getBoundingClientRect().left;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const move = (e: PointerEvent) => {
      const width = e.clientX - left;
      sidebar.open = width >= SIDEBAR_COLLAPSE;
      if (sidebar.open) sidebar.resize(width);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      sidebar.saveWidth();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  }

  const newThread = (parent?: string) => {
    navigate(parent ? { name: "new", param: parent } : "new");
    sidebar.settle();
  };
</script>

<aside
  style:--sidebar-width="{sidebar.width}px"
  class="app-side relative flex w-(--sidebar-width) shrink-0 flex-col bg-sidebar text-[14px] md:z-10 md:shadow-[8px_0_12px_-6px_var(--edge-shadow-strong)] max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-30 max-md:w-72 max-md:shadow-float"
>
  <div class="min-h-0 flex-1 overflow-y-auto px-2 pt-2" role="tree" tabindex="-1" aria-label="Threads">
    <div class="sticky top-0 z-10 -mx-2 -mt-2 bg-sidebar px-2 pt-2">
      <div data-tree-id="pai" class="group mb-1 flex h-8 items-center gap-0.5 rounded-sm pr-1 transition-colors has-[a:focus-visible]:bg-ink-10 has-[a:focus-visible]:text-ink {home ? 'bg-ink-10 text-ink' : 'text-ink-70 hover:bg-ink-5 hover:text-ink'}">
        <a href={href("home")} class="flex min-w-0 flex-1 items-center gap-2 self-stretch pl-1 outline-none" onclick={() => sidebar.settle()}>
          <span class="grid size-5 shrink-0 place-items-center text-ink-70"><House size={17} /></span>
          <span class="min-w-0 flex-1 truncate font-semibold">General</span>
          {#if waiting}<span class="inline-flex shrink-0 items-center gap-0.5 text-[12px] font-medium text-hand tabular-nums"><Hand size={12} />{waiting}</span>{/if}
        </a>
        <span class="flex items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 max-md:opacity-100">
          <button class={action} aria-label="Hide sidebar" title="Hide sidebar (⌘\)" onclick={() => sidebar.toggle()}><PanelLeftClose size={16} /></button>
        </span>
        <button class={action} aria-label="New thread" title="New thread (⌃N)" onclick={() => newThread()}><Plus size={16} /></button>
      </div>
      <div class="mx-2 mb-1.5 h-px bg-line"></div>
    </div>
    {#if !desk.loaded}
      <div class="space-y-2 p-2" aria-hidden="true">
        {#each [72, 54, 86, 40, 66] as w, i (i)}<div class="h-4 animate-pulse rounded-sm bg-ink-5" style="width: {w}%"></div>{/each}
      </div>
    {:else}
      {#each shown as node (node.id)}
        <TreeItem {node} {active} onnew={newThread} />
      {:else}
        <p class="m-0 px-2 py-1 text-[13px] text-ink-45">No threads yet.</p>
      {/each}
      {#if shown.length < roots.length}
        <button class="flex h-7 w-full items-center rounded-sm pl-[30px] text-[13px] text-ink-45 transition-colors hover:bg-ink-5 hover:text-ink" onclick={() => (limit = shown.length + ROOT_BATCH)}>
          {roots.length - shown.length} more
        </button>
      {/if}
    {/if}
  </div>

  <div class="space-y-px px-2 py-2">
    <Popover bind:open={accountOpen} width="w-56" block>
      {#snippet trigger({ toggle })}
        <button class="{row} h-9" aria-label="Account" onclick={toggle}>
          {#if auth.user?.avatar}
            <img src={auth.user.avatar} alt="" class="size-5 shrink-0 rounded-full" />
          {:else}
            <span class="grid size-5 shrink-0 place-items-center rounded-full bg-ink-10 text-[11px] font-semibold text-ink-70">{(auth.user?.name ?? "?").slice(0, 1).toUpperCase()}</span>
          {/if}
          <span class="min-w-0 flex-1 truncate text-left">{auth.user?.name ?? "Account"}</span>
        </button>
      {/snippet}
      {#snippet children({ close })}
        <MenuItem onclick={() => { close(); onsettings(); }}><Settings size={16} /> Settings <kbd class="ml-auto font-mono text-[11px] text-ink-30" aria-hidden="true">⌘⇧,</kbd></MenuItem>
        <Separator />
        <MenuItem onclick={() => { close(); void auth.signOut(); }}><LogOut size={16} /> Sign out</MenuItem>
      {/snippet}
    </Popover>
  </div>
  <div
    class="absolute inset-y-0 -right-1 z-50 w-2 cursor-col-resize touch-none after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:-translate-x-1/2 after:bg-transparent after:opacity-50 hover:after:bg-ink-20 max-md:hidden"
    role="separator"
    aria-orientation="vertical"
    aria-label="Resize sidebar"
    onpointerdown={startResize}
  ></div>
</aside>
