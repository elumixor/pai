<script lang="ts">
  import { api } from "../api";
  import { desk, PAI } from "../desk.svelte";
  import { ago } from "../format";
  import { kindIcon } from "../kinds";
  import { md } from "../markdown";
  import type { Agent, LogMessage, TaskItem, TaskStatus } from "../types";
  import Icon from "../ui/Icon.svelte";
  import { KIND_ORDER } from "./tree";

  /**
   * The task board: the agent tree on the left (pai the root, every agent under its parent), four columns for the
   * node picked, a card dragged to another column moves the task, a card clicked opens the task beside the board.
   * The database knows seven statuses; the board shows four and keeps the finer one on the card.
   */
  let { slug, onselect, openAgent }: { slug?: string; onselect: (slug: string) => void; openAgent: (slug: string) => void } = $props();

  const WEEK = 7 * 86_400_000;
  type Column = "todo" | "doing" | "waiting" | "done";
  const COLUMNS: readonly { id: Column; label: string; statuses: readonly TaskStatus[] }[] = [
    { id: "todo", label: "Todo", statuses: ["inbox", "scheduled"] },
    { id: "doing", label: "In progress", statuses: ["active", "waiting_other"] },
    { id: "waiting", label: "Waiting on me", statuses: ["waiting_user"] },
    { id: "done", label: "Done", statuses: ["done", "dropped"] },
  ];
  const columnOf = (status: TaskStatus): Column => COLUMNS.find((c) => c.statuses.includes(status))?.id ?? "todo";
  const STATUS_LABEL: Record<TaskStatus, string> = { inbox: "inbox", active: "active", waiting_user: "waiting on you", waiting_other: "waiting on others", scheduled: "scheduled", done: "done", dropped: "dropped" };
  const DOT: Record<string, string> = { working: "busy", waiting: "waiting", queued: "queued", idle: "idle", closed: "dead" };
  const firstUrl = (...texts: (string | null | undefined)[]) => texts.map((t) => /https?:\/\/[^\s<>)]+/.exec(t ?? "")?.[0]).find(Boolean);
  const today = () => new Date().toISOString().slice(0, 10);
  const isOpen = (t: TaskItem) => t.status !== "done" && t.status !== "dropped";

  const selected = $derived(slug ?? PAI);
  let includeChildren = $state(true);
  let showAllDone = $state(false);
  let openId = $state<number | undefined>();
  let expanded = $state(new Set<number>());
  let over = $state<Column | undefined>();
  let dragging = $state<number | undefined>();
  let title = $state("");
  let panel = $state<{ task: TaskItem; children: TaskItem[]; log: LogMessage[] } | undefined>();
  let saved = $state("");
  const tasks = $derived(Object.values(desk.taskIndex));
  const agent = $derived(desk.bySlug(selected));

  /** Every agent under its parent, closed ones last; an unknown parent means the root. */
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
        out.push({ agent: a, depth });
        walk(a.slug, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  });

  /** The slugs under a node, itself included. */
  function subtree(root: string) {
    const out = new Set([root]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const a of desk.agents) if (a.parent && out.has(a.parent) && !out.has(a.slug)) (out.add(a.slug), (grew = true));
    }
    return out;
  }

  const visible = $derived.by(() => {
    const scope = includeChildren ? subtree(selected) : new Set([selected]);
    const cutoff = Date.now() - WEEK;
    return tasks.filter((t) => scope.has(t.owner) && (isOpen(t) || showAllDone || (t.updatedAt ?? 0) >= cutoff));
  });
  const ids = $derived(new Set(visible.map((t) => t.id)));
  // A task whose parent is on the board sits under it; one whose parent is elsewhere is a card of its own.
  const top = $derived(visible.filter((t) => !t.parentId || !ids.has(t.parentId)));
  const childrenOf = (id: number) => visible.filter((t) => t.parentId === id);
  const countsOf = (a: Agent) => {
    const scope = subtree(a.slug);
    const own = tasks.filter((t) => scope.has(t.owner) && isOpen(t));
    return COLUMNS.slice(0, 3).map((c) => own.filter((t) => c.statuses.includes(t.status)).length);
  };

  async function move(id: number, column: Column) {
    const t = desk.taskIndex[id];
    const status = COLUMNS.find((c) => c.id === column)!.statuses[0]!;
    if (!t || columnOf(t.status) === column) return;
    desk.upsertTask({ ...t, status, updatedAt: Date.now() });
    const result = await api.updateTask(id, { status });
    if (result.error) {
      desk.upsertTask(t);
      saved = result.error;
    }
  }

  async function create(event: KeyboardEvent) {
    if (event.key !== "Enter" || !title.trim()) return;
    const result = await api.createTask({ title: title.trim(), owner: selected });
    title = "";
    if (result.data) desk.upsertTask(result.data);
  }

  async function openPanel(id: number) {
    openId = id;
    panel = undefined;
    const t = desk.taskIndex[id];
    const [full, log] = await Promise.all([api.task(id).catch(() => undefined), t ? api.messages(t.owner, { limit: 300 }).catch(() => []) : Promise.resolve([])]);
    if (openId !== id) return;
    const task = full ?? t;
    if (task) panel = { task, children: full?.children ?? tasks.filter((x) => x.parentId === id), log: log.filter((m) => m.taskId === id) };
  }

  async function patch(changes: Parameters<typeof api.updateTask>[1]) {
    if (!panel) return;
    const result = await api.updateTask(panel.task.id, changes);
    saved = result.error ?? `saved ${ago(Date.now())}`;
    if (result.data) {
      desk.upsertTask(result.data);
      panel = { ...panel, task: { ...panel.task, ...result.data } };
    }
  }
  const linkOf = (t: TaskItem) => (t.source && /^https?:/.test(t.source) ? t.source : firstUrl(t.notes, t.nextAction));
</script>

{#snippet subtask(t: TaskItem)}
  <button class="subtask status-{t.status}" onclick={(e) => (e.stopPropagation(), void openPanel(t.id))}><Icon name={isOpen(t) ? "circle" : "check"} size={10} /><span class="ellipsis">{t.title}</span><span class="tag fine">{STATUS_LABEL[t.status]}</span></button>
{/snippet}

<div class="board-view" class:with-panel={openId !== undefined} data-testid="board">
  <aside class="board-tree">
    <header class="panel-head"><Icon name="board" size={13} /><h2>Projects</h2></header>
    <div class="board-tree-list">
      {#each ordered as { agent: a, depth } (a.slug)}
        {@const counts = countsOf(a)}
        <button class="agent-row" class:on={a.slug === selected} class:closed={a.status === "closed"} style="padding-left: {10 + depth * 14}px" title="{a.name} · {a.kind}" onclick={() => onselect(a.slug)}>
          <span class="dot {DOT[a.status] ?? ''}"></span>
          <span class="label">{a.name}</span>
          <span class="counts" title="todo · in progress · waiting on you">{#each counts as n, i (i)}<span class="count c-{COLUMNS[i]!.id}" class:zero={!n}>{n}</span>{/each}</span>
        </button>
      {:else}
        <p class="hint">No agents yet.</p>
      {/each}
    </div>
  </aside>

  <section class="board-main">
    <div class="board-toolbar">
      <h2>{agent?.name ?? selected}</h2>
      {#if agent && agent.slug !== PAI}<button class="iconbtn slim" title="open {agent.name}'s chat" aria-label="Open chat" onclick={() => openAgent(agent.slug)}><Icon name="message" size={12} /></button>{/if}
      <div class="task-new"><Icon name="plus" size={12} /><input type="text" placeholder="New task for {agent?.name ?? selected}…" bind:value={title} onkeydown={create} aria-label="New task" /></div>
      <span class="grow"></span>
      <div class="segmented">
        <button class="seg" class:on={includeChildren} title="fold the subtree's tasks into this board" onclick={() => (includeChildren = !includeChildren)}>include children</button>
        <button class="seg" class:on={showAllDone} title="done and dropped older than a week too" onclick={() => (showAllDone = !showAllDone)}>all done</button>
      </div>
    </div>
    <div class="board">
      {#each COLUMNS as c (c.id)}
        {@const items = top.filter((t) => columnOf(t.status) === c.id).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))}
        <section
          class="board-column col-{c.id}"
          class:over={over === c.id}
          data-testid="column-{c.id}"
          role="list"
          ondragover={(e) => (e.preventDefault(), (over = c.id))}
          ondragleave={() => over === c.id && (over = undefined)}
          ondrop={(e) => {
            e.preventDefault();
            over = undefined;
            const id = Number(e.dataTransfer?.getData("text/plain"));
            if (id) void move(id, c.id);
          }}
        >
          <h3 class="section-title"><span>{c.label}</span><span class="col-count">{items.length}</span></h3>
          <div class="board-cards">
            {#if !desk.loaded}
              <div class="skeleton skeleton-lines" aria-hidden="true">{#each [72, 54, 86] as w (w)}<span class="sk-line" style="--w: {w}%"></span>{/each}</div>
            {:else}
              {#each items as t (t.id)}
                {@const kids = childrenOf(t.id)}
                {@const link = linkOf(t)}
                {@const defaultStatus = c.statuses[0]}
                <div
                  class="board-card status-{t.status}"
                  class:on={t.id === openId}
                  class:dragging={dragging === t.id}
                  draggable="true"
                  role="button"
                  tabindex="0"
                  data-task={t.id}
                  onclick={() => void openPanel(t.id)}
                  onkeydown={(e) => e.key === "Enter" && void openPanel(t.id)}
                  ondragstart={(e) => (e.dataTransfer?.setData("text/plain", String(t.id)), (dragging = t.id))}
                  ondragend={() => (dragging = undefined)}
                >
                  <div class="card-top">
                    <span class="task-title">{t.title}</span>
                    {#if link}<a class="iconbtn slim" href={link} target="_blank" rel="noreferrer" title={link} onclick={(e) => e.stopPropagation()}><Icon name="link" size={11} /></a>{/if}
                  </div>
                  {#if t.nextAction}<div class="dim ellipsis next" title={t.nextAction}>{t.nextAction}</div>{/if}
                  <div class="task-sub">
                    {#if t.owner !== selected}<span class="owner">{desk.nameOf(t.owner)}</span>{/if}
                    {#if t.due}<span class="tag" class:due={t.due <= today() && isOpen(t)} title="due">{t.due}</span>{/if}
                    {#if t.status !== defaultStatus}<span class="tag fine">{STATUS_LABEL[t.status]}</span>{/if}
                    {#if kids.length}
                      <button class="subtasks" title={expanded.has(t.id) ? "fold the subtasks" : "show the subtasks"} onclick={(e) => {
                        e.stopPropagation();
                        const next = new Set(expanded);
                        if (next.has(t.id)) next.delete(t.id);
                        else next.add(t.id);
                        expanded = next;
                      }}><Icon name="chevron" size={10} />{kids.filter(isOpen).length}/{kids.length}</button>
                    {/if}
                  </div>
                  {#if kids.length && expanded.has(t.id)}<div class="subtask-list">{#each kids as k (k.id)}{@render subtask(k)}{/each}</div>{/if}
                </div>
              {:else}
                <p class="col-empty">Nothing here</p>
              {/each}
            {/if}
          </div>
        </section>
      {/each}
    </div>
  </section>

  <aside class="board-panel">
    {#if openId !== undefined}
      {#if !panel}
        <header class="panel-head"><span class="dim">#{openId}</span><span class="grow"></span><button class="iconbtn" title="close" aria-label="Close" onclick={() => (openId = undefined)}><Icon name="x" size={13} /></button></header>
        <div class="panel-body"><div class="skeleton skeleton-lines" aria-hidden="true">{#each [72, 54, 86, 40] as w (w)}<span class="sk-line" style="--w: {w}%"></span>{/each}</div></div>
      {:else}
        {@const t = panel.task}
        {@const link = linkOf(t)}
        <header class="panel-head">
          <span class="dim">#{t.id}</span>
          {#if link}<a class="iconbtn slim" href={link} target="_blank" rel="noreferrer" title={link}><Icon name="external" size={12} /></a>{/if}
          <span class="grow"></span><span class="note">{saved}</span>
          <button class="iconbtn" title="close" aria-label="Close" onclick={() => (openId = undefined)}><Icon name="x" size={13} /></button>
        </header>
        <div class="panel-body">
          <input class="panel-title" type="text" value={t.title} aria-label="Title" onchange={(e) => e.currentTarget.value.trim() && void patch({ title: e.currentTarget.value.trim() })} />
          <div class="panel-grid">
            <label class="panel-field"><span>owner</span><select value={t.owner} onchange={(e) => void patch({ owner: e.currentTarget.value })}>{#each ordered as { agent: a, depth } (a.slug)}<option value={a.slug}>{"  ".repeat(depth)}{a.name}</option>{/each}</select></label>
            <label class="panel-field"><span>status</span><select value={t.status} onchange={(e) => void patch({ status: e.currentTarget.value as TaskStatus })}>{#each Object.keys(STATUS_LABEL) as s (s)}<option value={s}>{STATUS_LABEL[s as TaskStatus]}</option>{/each}</select></label>
            <label class="panel-field"><span>due</span><input type="date" value={t.due ?? ""} onchange={(e) => void patch({ due: e.currentTarget.value || null })} /></label>
          </div>
          <label class="panel-field"><span>next action</span><input type="text" value={t.nextAction} placeholder="next action" onchange={(e) => void patch({ nextAction: e.currentTarget.value.trim() })} /></label>
          <label class="panel-field"><span>notes</span><textarea rows="5" placeholder="notes" value={t.notes ?? ""} onchange={(e) => void patch({ notes: e.currentTarget.value })}></textarea></label>
          {#if t.source}<p class="dim panel-source">source: {#if /^https?:/.test(t.source)}<a href={t.source} target="_blank" rel="noreferrer">{t.source}</a>{:else}{t.source}{/if}</p>{/if}
          {#if panel.children.length}<section class="panel-section"><h3 class="section-title">Subtasks <span class="dim">{panel.children.length}</span></h3>{#each panel.children as k (k.id)}{@render subtask(k)}{/each}</section>{/if}
          <section class="panel-section">
            <h3 class="section-title">Messages <span class="dim">{panel.log.length}</span></h3>
            {#each panel.log as m (m.id)}
              <div class="panel-msg"><div class="msg-meta"><Icon name={kindIcon(m.kind === "event" ? (m.meta.event ?? "event") : m.kind)} size={11} /><b>{desk.nameOf(m.from)}</b><span class="dim">→</span><span>{desk.nameOf(m.to)}</span><span class="grow"></span><time>{ago(m.createdAt)}</time></div><div class="msg-body" {@attach md(m.body)}></div></div>
            {:else}
              <p class="hint">Nothing logged about this task.</p>
            {/each}
          </section>
          <p class="dim panel-dates">created {t.createdAt ? ago(t.createdAt) : "?"} ago · updated {t.updatedAt ? ago(t.updatedAt) : "?"} ago</p>
        </div>
      {/if}
    {/if}
  </aside>
</div>
