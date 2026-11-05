<script lang="ts">
  import { CommandPalette, type PaletteItem } from "@desk/core/palette";
  import { TrashList } from "@desk/core/trash";
  import { ArrowUpToLine, Code, Hand, MessageSquare, Trash2, House, Inbox as InboxIcon, LogOut, PanelLeftClose, Plus, Settings } from "lucide-svelte";
  import { auth } from "../auth.svelte";
  import { desk } from "../desk.svelte";
  import { href, navigate } from "../router.svelte";
  import MenuItem from "../ui/MenuItem.svelte";
  import Popover from "../ui/Popover.svelte";
  import Separator from "../ui/Separator.svelte";
  import { inbox } from "../stores/inbox.svelte";
  import Inbox from "./Inbox.svelte";
  import { mover } from "./move.svelte";
  import { SIDEBAR_COLLAPSE, selection, sidebar } from "./state.svelte";
  import { ancestors, type TreeNode, generalWaiting } from "./tree";
  import Section from "./Section.svelte";

  /**
   * The sidebar, Keep's: General at the top where Keep has its workspace, every thread under it as a tree, its inbox and the account
   * at the bottom. Resized by its edge, dragged shut past a point.
   */
  let { roots, active, onsettings }: { roots: readonly TreeNode[]; active?: string; onsettings: () => void } = $props();

  let accountOpen = $state(false);
  let trashOpen = $state(false);
  $effect(() => {
    if (trashOpen) void desk.refreshTrash();
  });
  const trashItems = $derived(desk.trashed?.map((t) => ({ ...t, id: t.sessionId, title: t.title || t.shortId })) ?? null);
  let inboxOpen = $state(false);
  inbox.start();
  const home = $derived(active === "pai");
  const waiting = $derived(generalWaiting(desk.agents, desk.sessions, desk.needs, desk.paiSession?.sessionId));
  /** The top level in three: agents and threads on a Keep task, then the dev threads, then the chats on no task. */
  const groups = $derived.by(() => {
    const main: TreeNode[] = [];
    const dev: TreeNode[] = [];
    const chats: TreeNode[] = [];
    for (const node of roots) (node.id.startsWith("agent:") ? main : node.project ? dev : node.keep?.length ? main : chats).push(node);
    return { main, dev, chats };
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

  $effect(() => {
    sidebar.roots = roots;
  });

  /** Where the rows being moved can go: the top, an agent (agents and threads), a thread (threads only). */
  const destinations = $derived.by((): PaletteItem[] => {
    if (!mover.open) return [];
    const ids = mover.ids;
    const agentsMoved = ids.some((id) => id.startsWith("agent:"));
    const go = (target: string | null) => () => {
      mover.open = false;
      selection.clear();
      if (target) sidebar.set(target, true);
      void desk.move(ids, target);
    };
    const out: PaletteItem[] = [{ key: "top", label: "Top level", icon: ArrowUpToLine, run: go(null) }];
    const walk = (list: readonly TreeNode[], path: string) => {
      for (const n of list) {
        const under = ids.includes(n.id) || (ancestors(roots, n.id) ?? []).some((a) => ids.includes(a));
        if (under) continue;
        if (n.holds && !(agentsMoved && n.id.startsWith("thread:"))) out.push({ key: n.id, label: n.label, icon: n.icon, hint: path, quiet: out.length > 12, run: go(n.id) });
        walk(n.children, path ? `${path} › ${n.label}` : n.label);
      }
    };
    walk(roots, "");
    return out;
  });

  /** A click anywhere but on a tree row (or a menu acting on the selection) lets the selection go. */
  function clearOutside(event: PointerEvent) {
    if (!selection.selected.size) return;
    if ((event.target as Element).closest('[data-tree-id], [data-tree-more], [role="menu"], [role="dialog"], .ctx-menu')) return;
    selection.clear();
  }

  const newThread = (parent?: string) => {
    navigate(parent ? { name: "new", param: parent } : "new");
    sidebar.settle();
  };
</script>

<svelte:window onpointerdown={clearOutside} />

<aside
  style:--sidebar-width="{sidebar.width}px"
  class="app-side relative flex w-(--sidebar-width) shrink-0 flex-col bg-sidebar text-(length:--tree-size) md:z-10 md:shadow-[8px_0_12px_-6px_var(--edge-shadow-strong)] max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-30 max-md:w-72 max-md:shadow-float"
>
  <div
    class="min-h-0 flex-1 overflow-y-auto px-2 pt-2"
    role="tree"
    tabindex="-1"
    aria-label="Threads"
    ondragover={(e) => { if (selection.dragging && !(e.target as Element).closest('[role="treeitem"]')) e.preventDefault(); }}
    ondrop={(e) => {
      // Below the rows (or on General): the dragged rows go to the top.
      if (e.defaultPrevented || !selection.dragging || (e.target as Element).closest('[role="treeitem"]')) return;
      e.preventDefault();
      const ids = selection.dragging;
      selection.dragging = null;
      selection.clear();
      void desk.move(ids, null);
    }}
  >
    <div class="sticky top-0 z-10 -mx-2 -mt-2 bg-sidebar px-2 pt-2">
      <div data-tree-id="pai" class="group mb-1 flex h-8 items-center gap-0.5 rounded-sm pr-1 transition-colors has-[a:focus-visible]:bg-ink-10 has-[a:focus-visible]:text-ink {home ? 'bg-(--tree-bg-on) text-(--tree-ink-on)' : 'text-(--tree-ink) hover:bg-ink-5 hover:text-ink'}">
        <a href={href("home")} class="flex min-w-0 flex-1 items-center gap-2 self-stretch pl-1 outline-none" onclick={() => sidebar.settle()}>
          <span class="grid size-5 shrink-0 place-items-center text-ink-70"><House size={17} /></span>
          <span class="min-w-0 flex-1 truncate font-semibold">General</span>
          {#if waiting}<span class="inline-flex shrink-0 items-center gap-0.5 text-[12px] font-medium text-hand tabular-nums"><Hand size={12} />{waiting}</span>{/if}
        </a>
        <span class="flex items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 max-md:opacity-100">
          <button class={action} aria-label="Hide sidebar" title="Hide sidebar (⌘\)" onclick={() => sidebar.toggle()}><PanelLeftClose size={16} /></button>
        </span>
        <button class={action} aria-label="New thread" title="New thread (⌘N)" onclick={() => newThread()}><Plus size={16} /></button>
      </div>
      <div class="mx-2 mb-1.5 h-px bg-line"></div>
    </div>
    {#if !desk.loaded}
      <div class="space-y-2 p-2" aria-hidden="true">
        {#each [72, 54, 86, 40, 66] as w, i (i)}<div class="h-4 animate-pulse rounded-sm bg-ink-5" style="width: {w}%"></div>{/each}
      </div>
    {:else}
      {#if roots.length}
        <Section key="main" nodes={groups.main} {active} onnew={newThread} />
        {#if groups.dev.length}<Section key="dev" label="Dev" nodes={groups.dev} {active} onnew={newThread} />{/if}
        {#if groups.chats.length}<Section key="chats" label="Chats" nodes={groups.chats} {active} onnew={newThread} />{/if}
      {:else}
        <p class="m-0 px-2 py-1 text-[13px] text-ink-45">No threads yet.</p>
      {/if}
    {/if}
  </div>

  <div class="flex items-center gap-0.5 px-2 py-2">
    <div class="min-w-0 flex-1">
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
    <Popover bind:open={trashOpen} width="w-80" align="end">
      {#snippet trigger({ toggle })}
        <button class="grid size-9 shrink-0 place-items-center rounded-sm text-ink-45 transition-colors hover:bg-ink-5 hover:text-ink" aria-label="Trash" title="Trash" aria-expanded={trashOpen} onclick={toggle}>
          <Trash2 size={17} />
        </button>
      {/snippet}
      {#snippet children({ close })}
        <TrashList
          items={trashItems}
          href={(item) => href({ name: "thread", param: item.id })}
          onopen={(item) => { close(); navigate({ name: "thread", param: item.id }); }}
          onrestore={(item) => void desk.restore([item.id])}
          onpurge={(item) => void desk.purge([item.id])}
        >
          {#snippet lead(item)}{#if item.kind === "code"}<Code size={16} />{:else}<MessageSquare size={16} />{/if}{/snippet}
        </TrashList>
      {/snippet}
    </Popover>
    <Popover bind:open={inboxOpen} width="w-96" align="end">
      {#snippet trigger({ toggle })}
        <button class="relative grid size-9 shrink-0 place-items-center rounded-sm text-ink-45 transition-colors hover:bg-ink-5 hover:text-ink" aria-label={inbox.unread ? `Inbox, ${inbox.unread} unread` : "Inbox"} title="Inbox" aria-expanded={inboxOpen} onclick={toggle}>
          <InboxIcon size={17} />
          {#if inbox.unread}<span class="absolute top-1 right-0.5 min-w-4 rounded-full bg-accent px-1 text-center text-[10px] leading-4 font-medium text-accent-ink tabular-nums" aria-hidden="true">{inbox.unread > 99 ? "99+" : inbox.unread}</span>{/if}
        </button>
      {/snippet}
      {#snippet children({ close })}
        <Inbox onclose={close} />
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
<CommandPalette items={destinations} bind:open={mover.open} shortcut={false} placeholder={mover.ids.length > 1 ? `Move ${mover.ids.length} into…` : "Move into…"} />
