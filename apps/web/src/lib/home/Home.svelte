<script lang="ts">
  import { fly } from "svelte/transition";
  import { api } from "../api";
  import ChatView, { type ChatSpec } from "../chat/ChatView.svelte";
  import type { Prefs } from "../chat/Compose.svelte";
  import { desk, PAI } from "../desk.svelte";
  import { reveal as pendingReveal, type RevealTarget } from "../reveal.svelte";
  import { navigate, type Route } from "../router.svelte";
  import { intents, openAgent } from "../shell/open.svelte";
  import type { Effort, Need, SessionSummary, Upload } from "../types";
  import Icon from "../ui/Icon.svelte";
  import AgentDesk from "./AgentDesk.svelte";
  import Board from "./Board.svelte";
  import Crumbs, { type Crumb } from "./Crumbs.svelte";
  import Notes from "./Notes.svelte";
  import ProjectPeek from "./ProjectPeek.svelte";
  import ProjectThreads from "./ProjectThreads.svelte";
  import PTree from "./PTree.svelte";
  import TaskHead from "./TaskHead.svelte";
  import { type Centre, DEV_LABEL, devAgent, isCode, projectName, threadOf, treeRows } from "./tree";
  import { views } from "./views.svelte";

  /**
   * The room: on the left the tree — General, the agents as they report, their tasks and the threads they run; in the
   * middle the chat (pai's own, an agent's, a task's, a thread's), an agent's desk or notes, or the board; over it the
   * way here, with the views of the place after it; above the box the hand with what waits on him.
   */
  let { route }: { route: Route } = $props();

  /** What a session thinks at when nothing was asked for: Claude Code's own default. */
  const DEFAULT_EFFORT: Effort = "high";
  const centre = $derived.by((): Centre => {
    switch (route.name) {
      case "chat":
        return route.param === PAI ? { kind: "chat" } : { kind: "agent", slug: route.param! };
      case "board":
        return { kind: "board", slug: route.param };
      case "task":
        return { kind: "task", id: Number(route.param) };
      case "thread":
        return { kind: "thread", id: route.param! };
      case "project":
        return { kind: "project", slug: route.param! };
      default:
        return { kind: "chat" };
    }
  });
  let detached = $state(false);
  let treeOpen = $state(false);
  let chat = $state<ChatView>();
  /** The first message of a thread just started from a box, shown in it until its transcript has it. */
  let seed = $state<{ id: string; text: string } | undefined>();
  let fetchedTask = $state<Awaited<ReturnType<typeof api.task>> | undefined>();

  const openTask = $derived(centre.kind === "task" ? (desk.taskOf(centre.id) ?? (fetchedTask?.id === centre.id ? fetchedTask : undefined)) : undefined);
  $effect(() => {
    if (centre.kind !== "task" || desk.taskOf(centre.id)) return;
    const id = centre.id;
    void api.task(id).then((t) => (fetchedTask = t), () => undefined);
  });
  // Leaving the main chat turns the "new thread" switch off: it belongs to pai's box.
  $effect(() => {
    if (centre.kind !== "chat") detached = false;
  });
  $effect(() => {
    void route;
    treeOpen = false;
  });
  // ⌃N: the main chat's box, switched to a new thread of its own.
  $effect(() => {
    if (intents.newThread && centre.kind === "chat") {
      intents.newThread = false;
      detached = true;
    }
  });

  /** The slug whose page the centre is, with views to switch between: General's, an agent's, a repo's. */
  const pageSlug = $derived(centre.kind === "chat" && !detached ? PAI : centre.kind === "agent" ? centre.slug : centre.kind === "project" ? `project:${centre.slug}` : undefined);
  const view = $derived(pageSlug ? views.of(pageSlug) : "chat");

  const rows = $derived(treeRows({ agents: desk.agents, tasks: desk.tasks, needs: desk.needs, projects: desk.projects, centre, openTask }));
  const openRow = (id: string) => {
    if (id.startsWith("thread:")) navigate({ name: "thread", param: id.slice("thread:".length) });
    else if (id.startsWith("project:")) navigate({ name: "project", param: id.slice("project:".length) });
    else if (id.startsWith("task:")) navigate({ name: "task", param: id.slice("task:".length) });
    else openAgent(id);
  };
  let peek = $state<ProjectPeek>();
  const armRow = (id: string) => (!id.includes(":") && id !== PAI && desk.bySlug(id) && peek ? peek.arm(id) : undefined);

  // ---- the crumbs ------------------------------------------------------------------------------------------------

  const lineage = (slug: string) => {
    const chain: { slug: string; name: string }[] = [];
    for (let a = desk.bySlug(slug); a && a.slug !== PAI; a = a.parent ? desk.bySlug(a.parent) : undefined) {
      const at = a.slug;
      if (chain.some((c) => c.slug === at)) break;
      chain.unshift(a);
    }
    return chain;
  };
  const crumbs = $derived.by((): Crumb[] => {
    if (centre.kind === "board") return [];
    if (centre.kind === "chat") return [detached ? { key: "new", label: "New thread" } : { key: PAI, label: "General" }];
    const general: Crumb = { key: PAI, label: "General", open: () => navigate("home") };
    const agentCrumb = (a: { slug: string; name: string }): Crumb => ({ key: `agent:${a.slug}`, label: a.name, open: () => openAgent(a.slug) });
    const projectCrumb = (slug: string): Crumb => ({ key: `project:${slug}`, label: slug, open: () => navigate({ name: "project", param: slug }) });
    const dev = devAgent(desk.agents);
    if (centre.kind === "project") return [general, dev ? agentCrumb(dev) : { key: "dev", label: DEV_LABEL }, projectCrumb(centre.slug)];
    if (centre.kind === "thread") {
      const found = threadOf(desk.agents, centre.id);
      const title = found ? found.thread.title || found.thread.shortId : "New thread";
      const way: Crumb[] = !found
        ? []
        : isCode(found.thread)
          ? [dev ? agentCrumb(dev) : { key: "dev", label: DEV_LABEL }, projectCrumb(projectName(found.thread))]
          : found.owner.slug !== PAI && found.thread.origin === "agent"
            ? [agentCrumb(found.owner)]
            : [];
      return [general, ...way, { key: `thread:${centre.id}`, label: title, title }];
    }
    const slug = centre.kind === "agent" ? centre.slug : (openTask?.owner ?? PAI);
    const chain = lineage(slug).map(agentCrumb);
    if (!chain.length && slug !== PAI) chain.push({ key: `agent:${slug}`, label: desk.bySlug(slug)?.name ?? slug, open: () => openAgent(slug) });
    const task = centre.kind === "task" ? [{ key: `task:${centre.id}`, label: openTask ? `#${centre.id} ${openTask.title}` : `#${centre.id}`, title: openTask?.title }] : [];
    return [general, ...chain, ...task];
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
  /** A new thread from a box: started with its first message, then opened. */
  const startThread = (project?: string) => async (text: string, images: readonly Upload[]) => {
    const result = await api.startThread(text, images, project);
    const started = result.data as SessionSummary | undefined;
    if (result.error || !started?.sessionId) return void chat?.setNote(result.error ?? "no thread came back");
    seed = { id: started.sessionId, text: text || "(image)" };
    detached = false;
    navigate({ name: "thread", param: started.sessionId });
  };

  const spec = $derived.by((): ChatSpec | undefined => {
    if (centre.kind === "chat")
      return { key: PAI, agent: PAI, parent: "user", live: () => desk.refreshPai(), prefs: paiPrefs, setPrefs: setPaiPrefs, send: (text, images) => api.sendPai(text, images), placeholder: "Message pai…", divert: () => (detached ? startThread() : undefined) };
    if (centre.kind === "agent") {
      const a = desk.bySlug(centre.slug);
      const slug = centre.slug;
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
    if (centre.kind === "task") {
      const id = centre.id;
      const owner = openTask?.owner ?? PAI;
      const a = desk.bySlug(owner);
      return {
        key: `task${id}`,
        agent: owner,
        task: id,
        parent: owner === PAI ? "user" : (a?.parent ?? PAI),
        send: (text, images) => (owner === PAI ? api.sendPai(`${text}\n\n(task #${id})`, images) : api.messageAgent(owner, text, id, images)),
        placeholder: `Message ${owner === PAI ? "pai" : (a?.name ?? owner)} about this task…`,
      };
    }
    if (centre.kind === "thread") {
      const id = centre.id;
      const t = () => threadOf(desk.agents, id)?.thread;
      return {
        key: id,
        agent: "thread",
        parent: "user",
        session: id,
        seed: seed?.id === id ? seed.text : undefined,
        prefs: () => {
          const thread = t();
          return thread ? { model: thread.modelPref ?? thread.model ?? undefined, effort: thread.effort ?? DEFAULT_EFFORT } : undefined;
        },
        setPrefs: async (changes) => ({ error: (await api.reconfigure(id, changes)).error }),
        send: (text, images) => api.sendThread(id, text, images),
        placeholder: "Message this thread…",
      };
    }
    if (centre.kind === "project") {
      const slug = centre.slug;
      return { key: `project:${slug}`, agent: "thread", parent: "user", send: async () => ({ error: "start the thread first" }), placeholder: `Start a thread in ${slug}…`, divert: () => startThread(slug) };
    }
    return undefined;
  });
  /** What remounts the centre: another place, or another view of it. */
  const centreKey = $derived(`${JSON.stringify(centre)}:${view}:${centre.kind === "task" ? (openTask?.owner ?? "") : ""}`);

  // ---- the hand: what waits on him; a press goes to the next one, oldest first --------------------------------

  const needs = $derived([...desk.needs].sort((a, b) => a.createdAt - b.createdAt));
  let cursor = 0;
  function nextNeed() {
    if (!needs.length) return;
    const need = needs[cursor % needs.length]!;
    cursor = (cursor + 1) % needs.length;
    void revealNeed(need);
  }
  /** A need's row: in an agent's chat while that one is open, else in the main chat, where every ask to him lands. */
  async function revealNeed(n: Need) {
    const target: RevealTarget = n.kind === "ask" ? { askId: n.askId } : n.kind === "task" ? { taskId: n.taskId } : n.kind === "draft" ? { messageId: undefined, taskId: n.taskId } : { question: true };
    if ((centre.kind === "agent" || centre.kind === "task") && view === "chat" && spec?.agent === n.agent && (await chat?.reveal(target))) return;
    if (centre.kind === "chat" && views.of(PAI) === "chat" && (await chat?.reveal(target))) return;
    views.set(PAI, "chat");
    pendingReveal.ask(PAI, target);
    navigate("home");
  }

  function setView(next: typeof view) {
    if (!pageSlug || next === view) return;
    views.set(pageSlug, next);
  }
  /** The chat of a page, with its box focused: where a task is asked for. */
  function toChat() {
    if (!pageSlug) return;
    views.set(pageSlug, "chat");
    setTimeout(() => chat?.focus(), 80);
  }
  /** Whose tasks are on a desk: the agent's own and those of the sub-agents under it, not a standing agent's below. */
  const underDesk = (slug: string) => (owner: string) => {
    for (let a = desk.bySlug(owner); a; a = a.parent ? desk.bySlug(a.parent) : undefined) {
      if (a.slug === slug) return true;
      if (a.kind !== "sub") return false;
    }
    return owner === slug;
  };
  /** Whose tasks a project's desk holds: the agents that work in that repo, and their sub-agents. */
  const underProject = (project: string) => (owner: string) => {
    for (let a = desk.bySlug(owner); a; a = a.parent ? desk.bySlug(a.parent) : undefined) {
      if (a.project === project) return true;
      if (a.kind !== "sub") return false;
    }
    return false;
  };
  const openTaskPage = (id: number) => navigate({ name: "task", param: String(id) });
  const projectPath = $derived(centre.kind === "project" ? desk.projects.find((p) => p.slug === centre.slug)?.path : undefined);

  $effect(() => {
    chat?.setPlaceholder(detached ? "Start a new thread…" : undefined);
    if (detached) chat?.focus();
  });
</script>

{#snippet hand()}
  {#if needs.length}
    <div class="needs"><button class="needs-btn" title="what waits on you — press to go to the next" onclick={nextNeed}><Icon name="hand" size={15} /><span>{needs.length}</span></button></div>
  {/if}
{/snippet}
{#snippet detach()}
  <button class="compose-tool detach" class:on={detached} title="start a new thread on its own: not pai, no project" onclick={() => (detached = !detached)}><Icon name="plus" size={12} /><span>New thread</span></button>
{/snippet}

<section class="home" class:board-mode={centre.kind === "board"} class:tree-open={treeOpen}>
  <button class="nav-item tree-toggle" class:on={treeOpen} title="the tree" aria-label="Agents and tasks" onclick={() => (treeOpen = !treeOpen)}><Icon name="list" size={15} /></button>
  <aside class="home-side" aria-label="Agents, tasks and threads">
    {#if desk.loaded}
      <PTree {rows} onopen={openRow} arm={armRow} />
    {:else}
      <div class="skeleton skeleton-list" aria-hidden="true">{#each [72, 54, 86, 40, 66, 48, 78, 58, 72] as w, i (i)}<span class="sk-line" style="--w: {w}%"></span>{/each}</div>
    {/if}
  </aside>
  <section class="home-centre" class:detached>
    {#key centreKey}
      <div class="centre-page" class:wide={centre.kind === "board"} in:fly={{ y: 8, duration: 260 }}>
        {#if centre.kind === "board"}
          <Board slug={centre.slug} onselect={(s) => navigate(s === PAI ? "board" : { name: "board", param: s }, true)} openAgent={(s) => openAgent(s)} />
        {:else if pageSlug && view === "tasks"}
          <AgentDesk slug={pageSlug === PAI ? PAI : pageSlug.replace(/^project:/, "")} under={pageSlug.startsWith("project:") ? underProject(pageSlug.slice(8)) : underDesk(pageSlug)} openTask={openTaskPage} newTask={toChat} />
        {:else if pageSlug && view === "notes"}
          <Notes slug={pageSlug} />
        {:else if pageSlug && view === "threads"}
          <ProjectThreads path={projectPath} openThread={(id) => navigate({ name: "thread", param: id })} newThread={toChat} />
        {:else if spec && centre.kind === "task" && openTask}
          <div class="task-view">
            <TaskHead task={openTask} owner={desk.nameOf(openTask.owner)} working={desk.bySlug(openTask.owner)?.status === "working"} start={() => chat?.focus()} />
            <ChatView bind:this={chat} {spec} slot={hand} {openAgent} />
          </div>
        {:else if spec}
          <ChatView bind:this={chat} {spec} slot={hand} extra={centre.kind === "chat" ? detach : undefined} {openAgent} />
        {/if}
      </div>
    {/key}
  </section>
  <Crumbs {crumbs}>
    {#snippet tail()}
      {#if pageSlug}
        <span class="view-switch">
          {#each views.choices(pageSlug) as v (v.view)}
            <button class="view-btn" class:on={v.view === view} title={v.title} aria-label={v.title.replace(/:.*/, "")} onclick={() => setView(v.view)}><Icon name={v.icon} size={13} /></button>
          {/each}
        </span>
      {/if}
    {/snippet}
  </Crumbs>
  <ProjectPeek bind:this={peek} openTask={openTaskPage} reveal={(n) => void revealNeed(n)} />
</section>
