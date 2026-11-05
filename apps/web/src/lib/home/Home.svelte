<script lang="ts">
  import { TrashBanner } from "@desk/core/trash";
  import { PanelLeftOpen, Trash2 } from "lucide-svelte";
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
  import GeneralActions from "./GeneralActions.svelte";
  import { newChat } from "./new-chat.svelte";
  import NewChatOptions from "./NewChatOptions.svelte";
  import NewChatStatus from "./NewChatStatus.svelte";
  import Sheet from "../ui/Sheet.svelte";
  import type { Effort, Need, SessionSummary, Upload } from "../types";
  import Icon from "../ui/Icon.svelte";
  import { menus } from "../ui/menu-state.svelte";

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

  // ---- the trash: the open thread can go there from the bar or its crumb, and says so while it is there ----------

  const openThread = $derived(route.name === "thread" ? (desk.threadOf(route.param ?? "")?.sessionId ?? route.param) : undefined);
  const trashedHere = $derived(openThread ? desk.trashedOf(openThread) : undefined);
  const trashThread = (id: string) => void desk.trash([`thread:${id}`]);
  function crumbMenu(event: MouseEvent, id: string) {
    if (!id.startsWith("thread:") || desk.trashedOf(id.slice(7))) return;
    event.preventDefault();
    menus.openContext(event.clientX, event.clientY, [{ label: "Move to trash", icon: "trash", run: () => trashThread(id.slice(7)) }]);
  }

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

  /** Starts a blank chat as what it was made; with nothing chosen yet, Jev gets one last say. */
  const startNew = async (text: string, images: readonly Upload[]) => {
    if (!newChat.kind && text) await newChat.suggest(text);
    if (newChat.kind === "dev") {
      if (images.length) return void chat?.setNote("attachments cannot go to a Dev task yet");
      if (!newChat.project) return void chat?.setNote("pick a project first");
      const result = await api.startDevTask(text, newChat.project, newChat.model);
      if (result.error || !result.data?.sessionId) return void chat?.setNote(result.error ?? "no session came back");
      seed = { id: result.data.sessionId, text };
      return navigate({ name: "thread", param: result.data.sessionId }, true);
    }
    const prefs = { model: newChat.model, effort: newChat.effort };
    const result = await api.startThread(text, images, newChat.kind === "goal" ? "general" : undefined, prefs);
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
      if (!parent)
        return {
          key: "new:",
          agent: "thread",
          parent: "user",
          send: async () => ({ error: "start the thread first" }),
          placeholder: "Start a new thread…",
          divert: () => startNew,
          blank: options,
          above: status,
          ephemeral: true,
          ontext: (text, attached) => newChat.typed(text, attached),
          prefs: () => ({ model: newChat.model, effort: newChat.effort }),
          setPrefs: async (changes) => (newChat.choose(changes), {}),
        };
      return { key: `new:${parent ?? ""}`, agent: "thread", parent: "user", send: async () => ({ error: "start the thread first" }), placeholder: "Start a thread under this one…", divert: () => startThread(parent), ephemeral: true, ontext: (text, attached) => newChat.typed(text, attached) };
    }
    return undefined;
  });
  /** What remounts the chat: another place. */
  const chatKey = $derived(route.name === "settings" ? "home" : `${route.name}:${route.param ?? ""}`);
  $effect(() => {
    if (route.name === "new") {
      newChat.reset();
      setTimeout(() => chat?.focus(), 80);
    }
  });

  // ---- closing a chat not started: back where he came from, asking first if something was typed ------------------

  let cameFrom: Route = { name: "home" };
  $effect(() => {
    if (route.name !== "new" && route.name !== "settings") cameFrom = route;
  });
  let discarding = $state(false);
  let discardSheet = $state<Sheet>();
  const leaveNew = () => navigate(cameFrom, true);
  function closeKey(event: KeyboardEvent) {
    if (route.name !== "new" || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== "w") return;
    event.preventDefault();
    if (newChat.dirty) discarding = true;
    else leaveNew();
  }

  // ---- the hand: what waits on him; a press goes to the next one, oldest first --------------------------------

  /** Where a need is answered: a plain thread, else its agent's chat, else General. */
  const homeOf = (n: Need) => {
    if (n.session && desk.threadOf(n.session) && !desk.threadOf(n.session)?.agent) return `thread:${n.session}`;
    return n.agent && n.agent !== PAI && desk.bySlug(n.agent) ? `chat:${n.agent}` : "home";
  };
  const here = $derived(route.name === "thread" ? `thread:${openThread}` : route.name === "chat" ? `chat:${route.param}` : route.name === "new" ? "" : "home");
  const needs = $derived(desk.needs.filter((n) => homeOf(n) === here).sort((a, b) => a.createdAt - b.createdAt));
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

{#snippet options()}<NewChatOptions />{/snippet}
{#snippet status()}<NewChatStatus />{/snippet}

<svelte:window onkeydown={closeKey} />

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
          <a href={crumb.href} oncontextmenu={(e) => crumbMenu(e, crumb.id)} class="flex h-7 min-w-0 shrink items-center truncate rounded-sm px-1.5 text-ink-45 transition-colors hover:bg-ink-5 hover:text-ink">{crumb.label}</a>
        {:else}
          <span class="flex h-7 min-w-0 shrink items-center truncate px-1.5 text-ink" title={crumb.label} role="presentation" oncontextmenu={(e) => crumbMenu(e, crumb.id)}>{crumb.label}</span>
        {/if}
      {/each}
    </nav>
    <div class="crumb-under flex shrink-0 items-center"></div>
    {#if route.name === "home"}<GeneralActions />{/if}
    {#if openThread && !trashedHere}
      <button class="grid size-7 shrink-0 place-items-center rounded-sm text-ink-45 transition-colors hover:bg-ink-5 hover:text-ink" aria-label="Move to trash" title="Move to trash" onclick={() => trashThread(openThread)}><Trash2 size={16} /></button>
    {/if}
  </header>
  {#if trashedHere}
    <div class="shrink-0 py-2">
      <TrashBanner
        since={trashedHere.deletedAt}
        days={desk.trashDays}
        onrestore={() => void desk.restore([trashedHere.sessionId])}
        onpurge={() => void desk.purge([trashedHere.sessionId]).then(() => navigate("home"))}
      />
    </div>
  {/if}
  <section class="home-centre">
    {#key chatKey}
      <div class="centre-page" in:fly={{ y: 8, duration: 260 }}>
        {#if spec}<ChatView bind:this={chat} {spec} slot={hand} {openAgent} />{/if}
      </div>
    {/key}
  </section>
  {#if discarding}
    <Sheet bind:this={discardSheet} label="Discard this message?" onclose={() => (discarding = false)}>
      {#snippet head()}<h2 class="m-0 text-[15px] font-medium">Discard this message?</h2>{/snippet}
      <p class="m-0 text-[13px] text-ink-70">What you typed here will be lost.</p>
      <div class="mt-4 flex justify-end gap-2">
        <button class="h-8 rounded-sm bg-ink-5 px-3 text-[13px] transition-colors hover:bg-ink-10" onclick={() => void discardSheet?.close()}>Keep writing</button>
        <button class="h-8 rounded-sm bg-ink-5 px-3 text-[13px] font-medium text-hot transition-colors hover:bg-ink-10" onclick={() => { discarding = false; leaveNew(); }}>Discard</button>
      </div>
    </Sheet>
  {/if}
</main>
