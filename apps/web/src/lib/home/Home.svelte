<script lang="ts">
  import { PanelLeftOpen } from "lucide-svelte";
  import { fly } from "svelte/transition";
  import { api } from "../api";
  import ChatView, { type ChatSpec } from "../chat/ChatView.svelte";
  import type { Prefs } from "../chat/Compose.svelte";
  import { desk, PAI } from "../desk.svelte";
  import { reveal as pendingReveal, type RevealTarget } from "../reveal.svelte";
  import { href, navigate, type Route } from "../router.svelte";
  import { openAgent } from "../shell/open.svelte";
  import { sidebar } from "../sidebar/state.svelte";
  import { ancestors, type TreeNode, threadTitle } from "../sidebar/tree";
  import type { Effort, Need, SessionSummary, Upload } from "../types";
  import Icon from "../ui/Icon.svelte";

  /**
   * What the sidebar opened: General, an agent's chat, a thread, or a new thread (under the one it was started from).
   * Over it the way here, as the tree has it; above the box the hand with what waits on him.
   */
  let { route, roots, active }: { route: Route; roots: readonly TreeNode[]; active?: string } = $props();

  /** What a session thinks at when nothing was asked for: Claude Code's own default. */
  const DEFAULT_EFFORT: Effort = "high";
  let chat = $state<ChatView>();
  /** The first message of a thread just started, shown in it until its transcript has it. */
  let seed = $state<{ id: string; text: string } | undefined>();

  // ---- the way here ----------------------------------------------------------------------------------------------

  const find = (list: readonly TreeNode[], id: string): TreeNode | undefined => {
    for (const n of list) {
      if (n.id === id) return n;
      const below = find(n.children, id);
      if (below) return below;
    }
    return undefined;
  };
  const crumbHref = (id: string) => (id.startsWith("agent:") ? href({ name: "chat", param: id.slice(6) }) : href({ name: "thread", param: id.slice(7) }));
  const crumbs = $derived.by(() => {
    const general = { id: PAI, label: "General", href: href("home") };
    if (route.name === "home") return [general];
    if (route.name === "new") {
      const parent = route.param ? `thread:${route.param}` : undefined;
      const way = parent ? [...(ancestors(roots, parent) ?? []), parent] : [];
      return [general, ...way.map((id) => ({ id, label: find(roots, id)?.label ?? "…", href: crumbHref(id) })), { id: "new", label: "New thread", href: undefined }];
    }
    const here = active ?? "";
    const way = ancestors(roots, here) ?? [];
    const label = find(roots, here)?.label ?? (route.name === "chat" ? (desk.bySlug(route.param ?? "")?.name ?? route.param) : (desk.threadOf(route.param ?? "") ? threadTitle(desk.threadOf(route.param ?? "")!) : "Thread"));
    return [general, ...way.map((id) => ({ id, label: find(roots, id)?.label ?? "…", href: crumbHref(id) })), { id: here, label: label ?? "", href: undefined }];
  });

  // ---- the chats -------------------------------------------------------------------------------------------------

  const paiPrefs = (): Prefs | undefined => (desk.paiSession ? { model: desk.paiSession.modelPref ?? desk.paiSession.model ?? desk.mainModel, effort: desk.paiSession.effort ?? DEFAULT_EFFORT } : undefined);
  async function setPaiPrefs(changes: Prefs) {
    const session = desk.paiSession;
    if (!session) return { error: "no session yet" };
    const result = await api.reconfigure(session.sessionId, changes);
    if (!result.error) desk.paiSession = { ...session, modelPref: changes.model === undefined ? session.modelPref : changes.model, effort: changes.effort === undefined ? session.effort : changes.effort };
    return { error: result.error };
  }
  /** A new thread: started with its first message, then opened. */
  const startThread = (parent?: string) => async (text: string, images: readonly Upload[]) => {
    const result = await api.startThread(text, images, parent);
    const started = result.data as SessionSummary | undefined;
    if (result.error || !started?.sessionId) return void chat?.setNote(result.error ?? "no thread came back");
    seed = { id: started.sessionId, text: text || "(image)" };
    void desk.refreshSessions();
    navigate({ name: "thread", param: started.sessionId }, true);
  };

  const spec = $derived.by((): ChatSpec | undefined => {
    if (route.name === "home" || route.name === "settings")
      return { key: PAI, agent: PAI, parent: "user", live: () => desk.refreshPai(), prefs: paiPrefs, setPrefs: setPaiPrefs, send: (text, images) => api.sendPai(text, images), placeholder: "Message pai…" };
    if (route.name === "chat") {
      const slug = route.param!;
      const a = desk.bySlug(slug);
      return {
        key: slug,
        agent: slug,
        parent: a?.parent ?? PAI,
        prefs: () => (desk.bySlug(slug)?.model ? { model: desk.bySlug(slug)!.model, effort: desk.bySlug(slug)!.effort ?? DEFAULT_EFFORT } : undefined),
        send: (text, images) => api.messageAgent(slug, text, undefined, images),
        placeholder: `Tell ${a?.name ?? slug}…`,
        disabled: a?.status === "closed" ? `${a.name} is closed` : undefined,
      };
    }
    if (route.name === "thread") {
      const id = route.param!;
      return {
        key: id,
        agent: "thread",
        parent: "user",
        session: id,
        seed: seed?.id === id ? seed.text : undefined,
        prefs: () => {
          const thread = desk.threadOf(id);
          return thread ? { model: thread.modelPref ?? thread.model ?? undefined, effort: thread.effort ?? DEFAULT_EFFORT } : undefined;
        },
        setPrefs: async (changes) => ({ error: (await api.reconfigure(id, changes)).error }),
        send: (text, images) => api.sendThread(id, text, images),
        placeholder: "Message this thread…",
      };
    }
    if (route.name === "new") {
      const parent = route.param;
      return { key: `new:${parent ?? ""}`, agent: "thread", parent: "user", send: async () => ({ error: "start the thread first" }), placeholder: parent ? "Start a thread under this one…" : "Start a new thread…", divert: () => startThread(parent) };
    }
    return undefined;
  });
  /** What remounts the chat: another place. */
  const chatKey = $derived(route.name === "settings" ? "home" : `${route.name}:${route.param ?? ""}`);
  $effect(() => {
    if (route.name === "new") setTimeout(() => chat?.focus(), 80);
  });

  // ---- the hand: what waits on him; a press goes to the next one, oldest first --------------------------------

  const needs = $derived([...desk.needs].sort((a, b) => a.createdAt - b.createdAt));
  let cursor = 0;
  function nextNeed() {
    if (!needs.length) return;
    const need = needs[cursor % needs.length]!;
    cursor = (cursor + 1) % needs.length;
    void revealNeed(need);
  }
  /** A need's row: in its thread or agent's chat while that one is open, else in General, where every ask to him lands. */
  async function revealNeed(n: Need) {
    const target: RevealTarget = n.kind === "ask" ? { askId: n.askId } : n.kind === "task" ? { taskId: n.taskId } : n.kind === "draft" ? { messageId: undefined, taskId: n.taskId } : { question: true };
    if (n.session && desk.threadOf(n.session) && !desk.threadOf(n.session)?.agent) {
      if (route.name === "thread" && desk.threadOf(route.param ?? "")?.sessionId === n.session && (await chat?.reveal(target))) return;
      return navigate({ name: "thread", param: n.session });
    }
    if (route.name === "chat" && spec?.agent === n.agent && (await chat?.reveal(target))) return;
    if (route.name === "home" && (await chat?.reveal(target))) return;
    const where = n.agent && n.agent !== PAI && desk.bySlug(n.agent) ? n.agent : PAI;
    pendingReveal.ask(where, target);
    openAgent(where);
  }
</script>

{#snippet hand()}
  {#if needs.length}
    <div class="needs"><button class="needs-btn" title="what waits on you — press to go to the next" onclick={nextNeed}><Icon name="hand" size={15} /><span>{needs.length}</span></button></div>
  {/if}
{/snippet}

<main class="relative flex min-w-0 flex-1 flex-col overflow-clip bg-page">
  <header class="app-bar relative z-10 flex h-11 shrink-0 items-center gap-1 px-3 text-[14px]">
    {#if !sidebar.open}
      <button class="grid size-7 shrink-0 place-items-center rounded-sm text-ink-45 transition-colors hover:bg-ink-5 hover:text-ink" aria-label="Show sidebar" title="Show sidebar (⌘\)" onclick={() => sidebar.toggle()}><PanelLeftOpen size={16} /></button>
    {/if}
    <nav class="flex min-w-0 flex-1 items-center gap-0.5" aria-label="Where you are">
      {#each crumbs as crumb, i (crumb.id)}
        {#if i}<span class="shrink-0 text-ink-20" aria-hidden="true">/</span>{/if}
        {#if crumb.href && i < crumbs.length - 1}
          <a href={crumb.href} class="flex h-7 min-w-0 shrink items-center truncate rounded-sm px-1.5 text-ink-45 transition-colors hover:bg-ink-5 hover:text-ink">{crumb.label}</a>
        {:else}
          <span class="flex h-7 min-w-0 shrink items-center truncate px-1.5 text-ink" title={crumb.label}>{crumb.label}</span>
        {/if}
      {/each}
    </nav>
    <div class="crumb-under flex shrink-0 items-center"></div>
  </header>
  <section class="home-centre">
    {#key chatKey}
      <div class="centre-page" in:fly={{ y: 8, duration: 260 }}>
        {#if spec}<ChatView bind:this={chat} {spec} slot={hand} {openAgent} />{/if}
      </div>
    {/key}
  </section>
</main>
