<script lang="ts">
  import { api } from "../api";
  import { desk, PAI } from "../desk.svelte";
  import { ago, modelName } from "../format";
  import type { IconName } from "../icons";
  import { md } from "../markdown";
  import { live } from "../stores/live.svelte";
  import { recall, remember } from "../storage";
  import type { Agent, AgentStatus, Ask, LogMessage, MessageKind, Routine, TaskStatus } from "../types";
  import Icon from "../ui/Icon.svelte";
  import { KIND_ORDER } from "../home/tree";

  /**
   * The staff: pai and the agents it runs, as a tree; one agent's log — every message to and from it — with a box to
   * write to it; and beside the log what waits on him (asks) and the task list. All of it follows the event stream.
   */
  const KEY = "pai.staff";
  const STATUS: Record<AgentStatus, { dot: string; label: string }> = {
    working: { dot: "busy", label: "working" },
    waiting: { dot: "waiting", label: "waiting on you" },
    queued: { dot: "queued", label: "queued" },
    idle: { dot: "idle", label: "idle" },
    closed: { dot: "dead", label: "closed" },
  };
  const KIND_ICON: Record<MessageKind, IconName> = { chat: "message", delegate: "delegate", report: "reply", request: "arrows", response: "arrows", ask: "help", answer: "check", notice: "bell", event: "zap" };
  const EVENT_ICON: Record<string, IconName> = { "agent.created": "bot", "agent.spawned": "bot", "agent.woken": "zap", "agent.closed": "power", "routine.fired": "clock", "item.arrived": "inbox", "calendar.upcoming": "calendar", answered: "check", sent: "send", error: "alert" };
  const TASK_STATUS: Partial<Record<TaskStatus, string>> = { waiting_user: "Waiting on you", active: "Active", inbox: "Inbox", waiting_other: "Waiting on others", scheduled: "Scheduled" };
  const money = (n: number) => `$${n.toFixed(n >= 10 ? 0 : 2)}`;

  let kept = recall<{ agent?: string; tab?: "asks" | "tasks" }>(KEY, {});
  let selected = $state(kept.agent ?? PAI);
  let tab = $state<"asks" | "tasks" | undefined>(kept.tab);
  let showClosed = $state(false);
  let asks = $state<Ask[]>([]);
  let routines = $state<Routine[]>([]);
  let rows = $state<LogMessage[] | undefined>();
  let input = $state("");
  let note = $state("");
  let newTask = $state("");
  let log = $state<HTMLDivElement>();
  let typed = $state<Record<number, string>>({});
  const keep = () => remember(KEY, JSON.stringify({ agent: selected, tab }));

  const agent = $derived(desk.bySlug(selected));
  const who = (party: string) => {
    if (party === "user") return "you";
    const a = desk.bySlug(party);
    if (a) return a.name;
    const routine = /^routine:(\d+)$/.exec(party);
    if (routine) return routines.find((r) => r.id === Number(routine[1]))?.name ?? `routine #${routine[1]}`;
    return party.replace(/^watcher:/, "");
  };
  const ordered = $derived.by(() => {
    const known = new Set(desk.agents.map((a) => a.slug));
    const children = new Map<string | null, Agent[]>();
    for (const a of desk.agents) {
      const parent = a.parent && known.has(a.parent) ? a.parent : null;
      children.set(parent, [...(children.get(parent) ?? []), a]);
    }
    const out: { agent: Agent; depth: number }[] = [];
    const walk = (parent: string | null, depth: number) => {
      for (const a of (children.get(parent) ?? []).sort((x, y) => Number(x.status === "closed") - Number(y.status === "closed") || KIND_ORDER[x.kind] - KIND_ORDER[y.kind] || x.name.localeCompare(y.name))) {
        // A closed agent is left out unless asked for; whatever still runs under it moves up a level.
        const shown = showClosed || a.status !== "closed";
        if (shown) out.push({ agent: a, depth });
        walk(a.slug, shown ? depth + 1 : depth);
      }
    };
    walk(null, 0);
    return out;
  });
  const lineage = $derived.by(() => {
    const chain: Agent[] = [];
    for (let a = desk.bySlug(selected); a && !chain.includes(a); a = a.parent ? desk.bySlug(a.parent) : undefined) chain.unshift(a);
    return chain;
  });
  const concerns = (m: LogMessage) => m.from === selected || m.to === selected || m.meta.agent === selected;
  const openAsk = (id: number | undefined) => (id === undefined ? undefined : asks.find((a) => a.id === id));
  const shownTab = $derived(tab ?? (asks.length ? "asks" : "tasks"));
  const ownRoutines = $derived(routines.filter((r) => r.agent === selected || r.owner === selected));
  const groups = $derived.by(() => {
    const open = desk.tasks;
    return (Object.keys(TASK_STATUS) as TaskStatus[]).map((status) => ({ status, items: open.filter((t) => t.status === status) })).filter((g) => g.items.length);
  });

  /** One group of the log: a message on its own, or a run of three or more events folded into a line. */
  const grouped = $derived.by(() => {
    const out: LogMessage[][] = [];
    for (const m of rows ?? []) {
      const last = out[out.length - 1];
      if (m.kind === "event" && last?.[0]?.kind === "event") last.push(m);
      else out.push([m]);
    }
    return out;
  });
  let openFolds = $state(new Set<number>());

  async function openLog() {
    rows = undefined;
    note = "";
    const slug = selected;
    const page = await api.messages(slug, { limit: 100 }).catch(() => [] as LogMessage[]);
    if (slug !== selected) return;
    rows = page;
    requestAnimationFrame(() => log && (log.scrollTop = log.scrollHeight));
  }
  $effect(() => {
    void selected;
    void openLog();
  });
  $effect(() => {
    void api.asks().then((a) => (asks = a), () => undefined);
    void api.routines().then((r) => (routines = r), () => undefined);
    return live.on((event) => {
      if (event.kind === "message.new") {
        const m = event.payload as unknown as LogMessage;
        if (rows && concerns(m) && !rows.some((r) => r.id === m.id)) {
          const stick = log ? log.scrollHeight - log.scrollTop - log.clientHeight < 60 : true;
          rows = [...rows, m];
          if (stick) requestAnimationFrame(() => log && (log.scrollTop = log.scrollHeight));
        }
        if (m.kind === "ask" || m.kind === "answer") void api.asks().then((a) => (asks = a), () => undefined);
      }
      if (event.kind === "ask.answered" || event.kind === "ask.created") void api.asks().then((a) => (asks = a), () => undefined);
    });
  });

  function select(slug: string) {
    if (!desk.bySlug(slug)) return;
    selected = slug;
    keep();
  }
  async function submit() {
    const text = input.trim();
    if (!text || agent?.status === "closed") return;
    input = "";
    const result = await api.messageAgent(selected, text);
    note = result.error ?? "";
  }
  async function answer(ask: Ask, text: string) {
    if (!text.trim()) return;
    const result = await api.answerAsk(ask.id, text.trim());
    if (result.error) note = result.error;
    else asks = asks.filter((a) => a.id !== ask.id);
  }
  async function closeAgent(a: Agent) {
    if (!confirm(`Close ${a.name}? It stops and reports back to ${who(a.parent ?? PAI)}.`)) return;
    const result = await api.closeAgent(a.slug);
    note = result.error ?? "";
  }
  async function addTask(event: KeyboardEvent) {
    if (event.key !== "Enter" || !newTask.trim()) return;
    const result = await api.createTask({ title: newTask.trim(), owner: selected });
    newTask = "";
    if (result.data) desk.upsertTask(result.data);
  }
  const foldSummary = (list: LogMessage[]) => `${list.length} events`;
</script>

{#snippet party(slug: string)}
  {#if desk.bySlug(slug)}<button class="party" title="open {who(slug)}" onclick={() => select(slug)}>{who(slug)}</button>{:else}<span class="party">{who(slug)}</span>{/if}
{/snippet}
{#snippet time(at: number)}<time title={new Date(at).toLocaleString()}>{ago(at)}</time>{/snippet}
{#snippet controls(ask: Ask)}
  <div class="ask-controls">
    {#if ask.options.length}<div class="q-options">{#each ask.options as option (option)}<button class="btn" onclick={() => void answer(ask, option)}>{option}</button>{/each}</div>{/if}
    {#if ask.freeText || !ask.options.length}
      <div class="row-inline ask-free"><input type="text" placeholder={ask.options.length ? "or answer in words…" : "your answer…"} bind:value={typed[ask.id]} onkeydown={(e) => e.key === "Enter" && void answer(ask, typed[ask.id] ?? "")} /><button class="iconbtn" title="answer" aria-label="Answer" onclick={() => void answer(ask, typed[ask.id] ?? "")}><Icon name="send" size={12} /></button></div>
    {/if}
  </div>
{/snippet}
{#snippet eventLine(m: LogMessage)}
  <div class="msg-event" class:error={m.meta.event === "error"}><Icon name={EVENT_ICON[m.meta.event ?? ""] ?? "zap"} size={11} />{#if m.meta.link}<a class="ellipsis" href={m.meta.link} target="_blank" rel="noreferrer" title={m.body}>{m.body}</a>{:else}<span class="ellipsis" title={m.body}>{m.body}</span>{/if}{@render time(m.createdAt)}</div>
{/snippet}

<div class="staff" data-testid="staff">
  <aside class="staff-tree">
    <header class="panel-head"><Icon name="users" size={13} /><h2>Staff</h2><span class="grow"></span><button class="iconbtn slim" class:on={showClosed} title="show closed agents" aria-label="Show closed agents" onclick={() => (showClosed = !showClosed)}><Icon name="power" size={12} /></button><button class="iconbtn slim" title="refresh" aria-label="Refresh" onclick={() => void desk.load()}><Icon name="refresh" size={12} /></button></header>
    <div class="staff-tree-list">
      {#each ordered as { agent: a, depth } (a.slug)}
        {@const status = STATUS[a.status] ?? STATUS.idle}
        {@const waiting = asks.filter((x) => x.agent === a.slug).length}
        {@const open = desk.tasks.filter((t) => t.owner === a.slug).length}
        <button class="agent-row" class:on={a.slug === selected} class:closed={a.status === "closed"} style="padding-left: {10 + depth * 14}px" title={[`${a.name} · ${a.kind}`, status.label, a.brief, a.model ? modelName(a.model) : ""].filter(Boolean).join("\n")} onclick={() => select(a.slug)}>
          <span class="dot {status.dot}"></span><span class="label">{a.name}</span>
          {#if waiting}<span class="badge ask">?{waiting}</span>{/if}
          {#if open}<span class="badge">{open}</span>{/if}
          <span class="agent-stats" title="turns today · cost">{a.turnsToday}t · {money(a.costUsd)}</span>
        </button>
      {:else}
        <p class="hint">No agents yet.</p>
      {/each}
    </div>
  </aside>

  <section class="staff-chat">
    {#if agent}
      <header class="panel-head staff-head">
        <Icon name={agent.kind === "orchestrator" ? "bot" : "user"} size={13} />
        <nav class="crumbs">{#each lineage as a, i (a.slug)}{#if i}<span class="crumb-sep">›</span>{/if}<button class="crumb" class:on={a.slug === selected} onclick={() => select(a.slug)}>{a.name}</button>{/each}</nav>
        <span class="tag status-{agent.status}">{(STATUS[agent.status] ?? STATUS.idle).label}</span>
        <span class="tag" title="what kind of agent">{agent.kind}</span>
        {#if agent.model}<span class="tag model" title={agent.model}>{modelName(agent.model)}</span>{/if}
        {#if agent.unresolvedTools?.length}<span class="tag warn" title="declared for it, but no MCP server here provides it">no server for {agent.unresolvedTools.join(", ")}</span>{/if}
        <span class="grow"></span>
        <span class="dim" title="turns today · what it has cost">{agent.turnsToday} turns · {money(agent.costUsd)}</span>
        {#if agent.slug !== PAI && agent.status !== "closed"}<button class="iconbtn" title="close {agent.name}" aria-label="Close {agent.name}" onclick={() => void closeAgent(agent)}><Icon name="power" size={13} /></button>{/if}
      </header>
      {#if agent.brief || ownRoutines.length}
        <div class="staff-brief">
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
          {#if agent.brief}<p class="staff-brief-text" title={agent.brief} onclick={(e) => e.currentTarget.classList.toggle("open")}>{agent.brief}</p>{/if}
          {#if ownRoutines.length}<div class="chips">{#each ownRoutines as r (r.id)}<span class="chip" class:off={!r.enabled} title="{r.schedule ? `schedule ${r.schedule}` : `on ${r.event}`} → {r.action}"><Icon name="clock" size={10} />{r.name}</span>{/each}</div>{/if}
        </div>
      {/if}
    {/if}
    <div class="staff-log" bind:this={log}>
      {#if !rows}
        <p class="hint">…</p>
      {:else if !rows.length}
        <p class="hint">Nothing said here yet.</p>
      {/if}
      {#each grouped as group (group[0]!.id)}
        {@const m = group[0]!}
        {#if m.kind === "event"}
          {#if group.length < 3}
            <div class="msg-events">{#each group as e (e.id)}{@render eventLine(e)}{/each}</div>
          {:else}
            <div class="msg-events folded" class:open={openFolds.has(m.id)}>
              <button class="msg-fold" onclick={() => (openFolds = new Set(openFolds.has(m.id) ? [...openFolds].filter((x) => x !== m.id) : [...openFolds, m.id]))}><Icon name="chevron" size={11} /><span class="ellipsis">{foldSummary(group)}</span>{@render time(group[group.length - 1]!.createdAt)}</button>
              {#if openFolds.has(m.id)}{#each group as e (e.id)}{@render eventLine(e)}{/each}{/if}
            </div>
          {/if}
        {:else if m.kind === "chat"}
          {@const mine = m.from === "user"}
          {@const toward = m.to !== selected && m.to !== "user" && !mine}
          <div class="msg chat" class:mine>
            <div class="msg-meta"><Icon name={mine ? "user" : "message"} size={11} />{@render party(m.from)}{#if toward}<span class="dim">→</span>{@render party(m.to)}{/if}{@render time(m.createdAt)}</div>
            <div class="msg-body" {@attach md(m.body)}></div>
          </div>
        {:else if m.kind === "ask"}
          {@const ask = openAsk(m.meta.askId)}
          <div class="msg-card ask" class:answered={!ask}>
            <div class="msg-meta"><Icon name="help" size={11} />{@render party(m.from)}<span class="dim">asks</span>{#if m.meta.priority && m.meta.priority !== "normal"}<span class="tag prio-{m.meta.priority}">{m.meta.priority}</span>{/if}<span class="grow"></span>{@render time(m.createdAt)}</div>
            <div class="msg-body" {@attach md(m.body)}></div>
            {#if ask}{@render controls(ask)}{:else if m.meta.askId !== undefined}<span class="dim ask-state">answered</span>{/if}
          </div>
        {:else if m.kind === "answer"}
          <div class="msg-line answer"><Icon name="check" size={11} /><span class="ellipsis" title={m.body}>{who(m.from)} answered: {m.body}</span>{@render time(m.createdAt)}</div>
        {:else if m.kind === "notice"}
          <div class="msg-line notice"><Icon name="bell" size={11} /><div class="msg-body" {@attach md(m.body)}></div>{@render time(m.createdAt)}</div>
        {:else}
          <div class="msg-card {m.kind}">
            <div class="msg-meta"><Icon name={KIND_ICON[m.kind]} size={11} /><span class="kind">{m.kind}</span>{@render party(m.from)}<span class="dim">→</span>{@render party(m.to)}{#if m.taskId}<span class="tag">#{m.taskId}</span>{/if}<span class="grow"></span>{@render time(m.createdAt)}</div>
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
            <div class="msg-body clamped" title="click to expand" onclick={(e) => e.currentTarget.classList.toggle("clamped")} {@attach md(m.body)}></div>
          </div>
        {/if}
      {/each}
    </div>
    <footer class="staff-compose">
      <div class="compose-row">
        <textarea rows="1" placeholder={agent?.status === "closed" ? `${agent.name} is closed` : selected === PAI ? "Message pai…" : `Message ${agent?.name ?? selected}…`} disabled={agent?.status === "closed"} bind:value={input} aria-label="Message" onkeydown={(e) => e.key === "Enter" && !e.shiftKey && !e.isComposing && (e.preventDefault(), void submit())}></textarea>
        <button class="iconbtn" title="send (enter)" aria-label="Send" onclick={submit}><Icon name="send" size={14} /></button>
      </div>
      <div class="compose-foot"><span class="note">{note}</span><span class="grow"></span><span class="dim">enter to send · shift+enter newline</span></div>
    </footer>
  </section>

  <aside class="staff-side">
    <header class="panel-head">
      <div class="segmented staff-tabs">
        <button class="seg" class:on={shownTab === "asks"} onclick={() => ((tab = "asks"), keep())}><Icon name="help" size={12} /><span>Asks</span>{#if asks.length}<span class="badge ask">{asks.length}</span>{/if}</button>
        <button class="seg" class:on={shownTab === "tasks"} onclick={() => ((tab = "tasks"), keep())}><Icon name="list" size={12} /><span>Tasks</span>{#if desk.tasks.length}<span class="badge">{desk.tasks.length}</span>{/if}</button>
      </div>
    </header>
    <div class="staff-side-body">
      {#if shownTab === "asks"}
        {#each asks as ask (ask.id)}
          <div class="ask-card" class:blocking={ask.blocking}>
            <div class="msg-meta">{@render party(ask.agent)}{#if ask.priority !== "normal"}<span class="tag prio-{ask.priority}">{ask.priority}</span>{/if}<span class="grow"></span>{@render time(ask.createdAt)}</div>
            <div class="msg-body" {@attach md(ask.question)}></div>
            {#if ask.context}<p class="ask-context dim">{ask.context}</p>{/if}
            {@render controls(ask)}
          </div>
        {:else}
          <p class="hint">Nothing waits on you.</p>
        {/each}
      {:else}
        <div class="task-new"><Icon name="plus" size={12} /><input type="text" placeholder="New task for {agent?.name ?? selected}…" bind:value={newTask} onkeydown={addTask} aria-label="New task" /></div>
        {#each groups as g (g.status)}
          <div class="task-group">
            <h3 class="section-title">{TASK_STATUS[g.status]} <span class="dim">{g.items.length}</span></h3>
            {#each g.items as t (t.id)}
              <div class="task-row status-{t.status}">
                <div class="task-text"><span class="task-title" title={t.title}>{t.title}</span><span class="task-sub">{@render party(t.owner)}{#if t.due}<span class="tag">{t.due}</span>{/if}{#if t.nextAction}<span class="dim ellipsis">{t.nextAction}</span>{/if}</span></div>
                <button class="iconbtn slim" title="done" aria-label="Done" onclick={async () => { const r = await api.updateTask(t.id, { status: "done" }); if (r.data) desk.upsertTask(r.data); }}><Icon name="check" size={12} /></button>
              </div>
            {/each}
          </div>
        {:else}
          <p class="hint">No open tasks.</p>
        {/each}
      {/if}
    </div>
  </aside>
</div>
