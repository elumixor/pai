<script lang="ts">
  import { forkMounts } from "../chat/model";
  import { TrashBanner } from "@desk/core/trash";
  import { OctagonX, Pause, PanelLeftOpen, Play, SlidersHorizontal, Trash2 } from "lucide-svelte";
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
  import AgentSheet, { AGENT_TABS, type AgentTab } from "../context/AgentSheet.svelte";
  import ChatConfig from "../context/ChatConfig.svelte";
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
  const BAR_BUTTON = "grid size-7 shrink-0 place-items-center rounded-sm text-ink-45 transition-colors hover:bg-ink-5 hover:text-ink";
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
  /** A chat that is part of General's tree has a setup worth showing; a detached one or a coding one is just Claude Code. */
  const configurable = $derived.by(() => {
    const thread = openThread ? desk.threadOf(openThread) : undefined;
    return Boolean(thread && !trashedHere && thread.kind !== "code" && thread.kind !== "claude" && (thread.parent || thread.agent));
  });
  let configOpen = $state(false);
  const trashThread = (id: string) => void desk.trash([`thread:${id}`]);
  function crumbMenu(event: MouseEvent, id: string) {
    if (!id.startsWith("thread:") || desk.trashedOf(id.slice(7))) return;
    event.preventDefault();
    menus.openContext(event.clientX, event.clientY, [{ label: "Move to trash", icon: "trash", run: () => trashThread(id.slice(7)) }]);
  }

  // ---- an agent, General included: what it runs on, and stopping, killing or deleting it --------------------------

  /** Whose setup the header offers. A trashed agent is out of the way until it is restored. */
  const agentHere = $derived(route.name === "home" ? PAI : route.name === "chat" ? route.param : undefined);
  const trashedAgent = $derived(route.name === "chat" ? desk.trashedAgentOf(route.param ?? "") : undefined);
  const openAgentRow = $derived(route.name === "chat" && !trashedAgent ? desk.bySlug(route.param ?? "") : undefined);
  let sheetTab = $state<AgentTab | undefined>();
  let killing = $state(false);
  let killReason = $state("");
  let killSheet = $state<Sheet>();

  const stopAgent = async (slug: string) => {
    const result = await api.stopAgent(slug);
    return { error: result.error };
  };
  const stopOpen = () => void (openAgentRow && stopAgent(openAgentRow.slug));
  const resumeOpen = () => void (openAgentRow && api.resumeAgent(openAgentRow.slug));
  /** A closed agent is off the tree but can still be opened, and deleted. */
  const trashOpen = () => {
    if (route.name !== "chat" || !route.param) return;
    void desk.trash([`agent:${route.param}`]);
    navigate("home");
  };
  async function kill() {
    if (!openAgentRow) return;
    const reason = killReason.trim();
    killing = false;
    killReason = "";
    await api.killAgent(openAgentRow.slug, reason || undefined);
    await desk.refreshAgents();
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
    const isPrivate = newChat.kind === "private";
    const result = await api.startThread(text, images, newChat.kind === "goal" ? "general" : undefined, { ...prefs, ...(isPrivate ? { private: true } : {}) });
    const started = result.data as SessionSummary | undefined;
    if (result.error || !started?.sessionId) return void chat?.setNote(result.error ?? "no thread came back");
    seed = { id: started.sessionId, text: text || "(image)" };
    if (isPrivate) openPrivate = started.sessionId;
    void desk.refreshSessions();
    navigate({ name: "thread", param: started.sessionId }, true);
  };

  /** The private chat open now: leaving it erases it. */
  let openPrivate: string | undefined;
  $effect(() => {
    const here = route.name === "thread" ? route.param : undefined;
    if (openPrivate && here !== openPrivate) {
      void api.closePrivate(openPrivate).then(() => desk.refreshSessions());
      openPrivate = undefined;
    }
    if (here && desk.threadOf(here)?.private) openPrivate = desk.threadOf(here)!.sessionId;
  });

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
        live: async () => desk.bySlug(slug)?.sessionId ?? undefined,
        stop: () => stopAgent(slug),
        above: a?.status === "paused" ? pausedCard : undefined,
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
        get placeholder() {
          return desk.threadOf(id)?.private ? "Private: erased when you leave…" : "Message this thread…";
        },
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
  const chatKey = $derived(route.name === "settings" ? "home" : `${route.name}:${(route.name === "thread" && forkMounts.get(route.param ?? "")) || (route.param ?? "")}`);
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
{#snippet pausedCard()}
  <div class="mb-2 flex flex-wrap items-center gap-2 rounded-sm bg-ink-5 px-3 py-2 text-[13px]">
    <Pause size={16} class="text-hand" />
    <span class="min-w-0 flex-1">You stopped {openAgentRow?.name}{openAgentRow?.pauseReason ? `: ${openAgentRow.pauseReason}` : ""}. Write what it should do, or:</span>
    <button class="h-7 rounded-sm bg-ink-10 px-2 transition-colors hover:bg-ink-20" onclick={resumeOpen}>Resume</button>
    <button class="h-7 rounded-sm px-2 text-hot transition-colors hover:bg-ink-10" onclick={() => (killing = true)}>Kill</button>
  </div>
{/snippet}
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
    {#if configurable}
      <button class={BAR_BUTTON} aria-label="Chat config" title="Chat config" onclick={() => (configOpen = true)}><SlidersHorizontal size={16} /></button>
    {/if}
    {#if agentHere && !trashedAgent}
      <!-- On a phone one button opens the sheet, whose tabs are the rest. -->
      {#each AGENT_TABS as item (item.id)}
        <button class="{BAR_BUTTON} max-md:hidden" aria-label={item.label} title={item.label} onclick={() => (sheetTab = item.id)}><item.icon size={16} /></button>
      {/each}
      <button class="{BAR_BUTTON} md:hidden" aria-label="What this agent runs on" title="What this agent runs on" onclick={() => (sheetTab = "instructions")}><SlidersHorizontal size={16} /></button>
    {/if}
    {#if openAgentRow && openAgentRow.status !== "closed"}
      {#if openAgentRow.status === "paused"}
        <button class={BAR_BUTTON} aria-label="Resume" title="Resume" onclick={resumeOpen}><Play size={16} /></button>
      {:else if openAgentRow.status === "working" || openAgentRow.status === "queued"}
        <button class={BAR_BUTTON} aria-label="Stop" title="Stop: it waits on you" onclick={stopOpen}><Pause size={16} /></button>
      {/if}
      <button class={BAR_BUTTON} aria-label="Kill" title="Kill: close it for good" onclick={() => (killing = true)}><OctagonX size={16} /></button>
    {/if}
    {#if route.name === "chat" && !trashedAgent}
      <button class={BAR_BUTTON} aria-label="Move to trash" title="Move to trash" onclick={trashOpen}><Trash2 size={16} /></button>
    {/if}
    {#if route.name === "home"}<GeneralActions />{/if}
    {#if openThread && !trashedHere}
      <button class={BAR_BUTTON} aria-label="Move to trash" title="Move to trash" onclick={() => trashThread(openThread)}><Trash2 size={16} /></button>
    {/if}
  </header>
  {#if configOpen}<ChatConfig session={openThread} onclose={() => (configOpen = false)} />{/if}
  {#if sheetTab && agentHere}<AgentSheet slug={agentHere} name={agentHere === PAI ? "General" : (openAgentRow?.name ?? agentHere)} tab={sheetTab} onclose={() => (sheetTab = undefined)} />{/if}
  {#if trashedAgent?.trashedAt}
    <div class="shrink-0 py-2">
      <TrashBanner since={trashedAgent.trashedAt} days={desk.trashDays} onrestore={() => void desk.restoreAgent(trashedAgent.slug)} onpurge={() => void desk.purgeAgent(trashedAgent.slug).then(() => navigate("home"))} />
    </div>
  {/if}
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
  {#if killing}
    <Sheet bind:this={killSheet} label="Kill {openAgentRow?.name}?" onclose={() => (killing = false)}>
      {#snippet head()}<h2 class="m-0 text-[15px] font-medium">Kill {openAgentRow?.name}?</h2>{/snippet}
      <p class="m-0 mb-2 text-[13px] text-ink-70">It closes now, with the workers under it. Its supervisor hears why.</p>
      <textarea class="w-full rounded-sm bg-ink-5 p-2 text-[13px] outline-none focus:ring-2 focus:ring-accent/40" rows="2" placeholder="Why, if you want to say" aria-label="Why" bind:value={killReason}></textarea>
      <div class="mt-4 flex justify-end gap-2">
        <button class="h-8 rounded-sm bg-ink-5 px-3 text-[13px] transition-colors hover:bg-ink-10" onclick={() => void killSheet?.close()}>Keep it</button>
        <button class="h-8 rounded-sm bg-ink-5 px-3 text-[13px] font-medium text-hot transition-colors hover:bg-ink-10" onclick={() => void kill()}>Kill</button>
      </div>
    </Sheet>
  {/if}
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
