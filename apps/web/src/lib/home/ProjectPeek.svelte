<script lang="ts">
  import { api } from "../api";
  import { desk } from "../desk.svelte";
  import { ago } from "../format";
  import type { IconName } from "../icons";
  import { md } from "../markdown";
  import type { Need, TaskItem, TaskStatus } from "../types";
  import { type HoverCard, hoverCard } from "../ui/hover";
  import Icon from "../ui/Icon.svelte";

  /**
   * The card a long hover over an agent opens: how many tasks wait, run, wait on him and are done; the open tasks (a
   * spinner only on one whose agent is at work right now); under them the decisions that wait on him, a row per task.
   * Hovering a decision opens a second card beside the first with what is asked, answerable in place. Both are
   * reachable with the pointer (`hover.ts`), both lists scroll.
   */
  let { openTask, reveal }: { openTask: (id: number) => void; reveal: (need: Need) => void } = $props();

  const TODO: readonly TaskStatus[] = ["inbox", "scheduled"];
  const ACTIVE: readonly TaskStatus[] = ["active", "waiting_other"];
  const DONE: readonly TaskStatus[] = ["done", "dropped"];
  const firstLine = (text: string) => text.replace(/^\[[^\]]+\]\s*/, "").split("\n").find((l) => l.trim()) ?? "";
  const rest = (text: string) => text.replace(/^\[[^\]]+\]\s*/, "").replace(/^\s*[^\n]*\n?/, "").trim();

  interface Decision {
    readonly key: string;
    readonly label: string;
    readonly needs: readonly Need[];
  }

  let card = $state<HTMLDivElement>();
  let fly = $state<HTMLDivElement>();
  let slug = $state<string | undefined>();
  let tasks = $state<readonly TaskItem[]>([]);
  let flyKey = $state<string | undefined>();
  let peek: HoverCard | undefined;
  let flyout: HoverCard | undefined;
  let typed = $state<Record<string, string>>({});
  let notes = $state<Record<string, string>>({});
  let settled = $state<Record<string, string>>({});

  const working = (owner: string) => desk.bySlug(owner)?.status === "working";
  /** The decisions an agent holds: its own and those of the sub-agents under it. */
  const needsOf = (of: string) => {
    const under = (s: string) => {
      for (let a = desk.bySlug(s); a; a = a.parent ? desk.bySlug(a.parent) : undefined) if (a.slug === of) return true;
      return false;
    };
    return desk.needs.filter((n) => n.agent && under(n.agent));
  };
  const needs = $derived(slug ? needsOf(slug) : []);
  const decisions = $derived.by(() => {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const grouped = new Map<string, Need[]>();
    for (const n of needs) {
      const key = n.taskId !== undefined ? `task:${n.taskId}` : n.id;
      grouped.set(key, [...(grouped.get(key) ?? []), n]);
    }
    return [...grouped].map(([key, list]): Decision => {
      const task = list[0]!.taskId !== undefined ? byId.get(list[0]!.taskId) : undefined;
      return { key, label: task?.title ?? firstLine(list[0]!.question), needs: [...list].sort((a, b) => a.createdAt - b.createdAt) };
    });
  });
  const deciding = $derived(new Set(needs.map((n) => n.taskId).filter((id) => id !== undefined)));
  const waits = (t: TaskItem) => deciding.has(t.id) || t.status === "waiting_user";
  const todo = $derived(tasks.filter((t) => TODO.includes(t.status) && !waits(t)));
  const active = $derived(tasks.filter((t) => ACTIVE.includes(t.status) && !waits(t)));
  const done = $derived(tasks.filter((t) => DONE.includes(t.status)));
  const rank = (t: TaskItem) => (t.status === "active" && working(t.owner) ? 0 : t.status === "active" ? 1 : t.status === "waiting_other" ? 2 : 3);
  const open = $derived([...active, ...todo].sort((a, b) => rank(a) - rank(b)));
  const flying = $derived(decisions.find((d) => d.key === flyKey));

  const taskIcon = (t: TaskItem): IconName | "spinner" => (t.status === "active" && working(t.owner) ? "spinner" : t.status === "waiting_other" ? "hourglass" : t.status === "active" ? "play" : "circle");

  $effect(() => {
    if (!card || !fly) return;
    const flyNode = fly;
    const cardNode = card;
    flyout = hoverCard(flyNode, {
      openMs: 120,
      sticky: () => Object.values(typed).some((v) => v.trim() !== ""),
      onHide: () => (flyKey = undefined),
      show: (row, key) => {
        if (!decisions.some((d) => d.key === key)) return false;
        flyKey = key;
        // Beside the card, level with the row; on the left when the right has no room.
        requestAnimationFrame(() => {
          flyNode.hidden = false;
          const box = cardNode.getBoundingClientRect();
          const at = row.getBoundingClientRect();
          const right = box.right + 8;
          flyNode.style.left = `${right + flyNode.offsetWidth <= window.innerWidth - 8 ? right : Math.max(8, box.left - 8 - flyNode.offsetWidth)}px`;
          flyNode.style.top = `${Math.max(8, Math.min(at.top - 14, window.innerHeight - flyNode.offsetHeight - 8))}px`;
        });
        return true;
      },
    });
    peek = hoverCard(cardNode, {
      openMs: 600,
      nested: () => (flyout ? [flyout] : []),
      onHide: () => flyout?.dismiss(),
      show: async (row, key) => {
        if (key !== slug) flyout?.dismiss();
        const full = await api.agent(key).catch(() => undefined);
        slug = key;
        tasks = full?.tasks ?? [];
        requestAnimationFrame(() => {
          cardNode.hidden = false;
          const at = row.getBoundingClientRect();
          cardNode.style.left = `${Math.min(at.right + 14, window.innerWidth - cardNode.offsetWidth - 8)}px`;
          cardNode.style.top = `${Math.max(8, Math.min(at.top - 8, window.innerHeight - cardNode.offsetHeight - 8))}px`;
        });
        return true;
      },
    });
  });

  /** The attachment a tree row carries: hovering it long enough opens the card. */
  export const arm = (key: string) => (node: HTMLElement) => {
    peek?.arm(node, key);
    return () => {};
  };
  const armFly = (key: string) => (node: HTMLElement) => {
    flyout?.arm(node, key);
  };

  async function reply(n: Need, text: string) {
    if (!text.trim()) return;
    notes = { ...notes, [n.id]: "" };
    const result = await api.answerNeed(n.id, text.trim());
    if (result.error) notes = { ...notes, [n.id]: result.error };
    else {
      settled = { ...settled, [n.id]: text.trim() };
      typed = { ...typed, [n.id]: "" };
      void desk.refreshNeeds();
    }
  }
</script>

<div class="peek" hidden bind:this={card}>
  <div class="peek-head">
    <span class="peek-count"><b>{todo.length}</b><span> todo</span></span>
    <span class="peek-count"><b>{active.length}</b><span> active</span></span>
    {#if needs.length}<span class="peek-count hand"><b>{needs.length}</b><span> {needs.length === 1 ? "decision" : "decisions"}</span></span>{/if}
    <span class="peek-count"><b>{done.length}</b><span> done</span></span>
  </div>
  {#if open.length}
    <div class="peek-tasks">
      {#each open as t (t.id)}
        {@const glyph = taskIcon(t)}
        <button class="peek-task" class:running={glyph === "spinner"} class:active={ACTIVE.includes(t.status)} title={t.nextAction || t.title} onclick={() => (peek?.dismiss(), openTask(t.id))}>
          {#if glyph === "spinner"}<span class="spinner"></span>{:else}<Icon name={glyph} size={14} />{/if}
          <span class="ellipsis">{t.title}</span>
        </button>
      {/each}
    </div>
  {/if}
  {#if decisions.length}
    <div class="peek-needs">
      {#each decisions as d (d.key)}
        <button class="peek-need" class:on={flyKey === d.key} onclick={() => (peek?.dismiss(), reveal(d.needs[0]!))} {@attach armFly(d.key)}>
          <Icon name="hand" size={13} /><span class="ellipsis">{d.label}</span>
          {#if d.needs.length > 1}<span class="peek-need-count">{d.needs.length}</span>{/if}
          <Icon name="chevron" size={8} />
        </button>
      {/each}
    </div>
  {/if}
</div>

<div class="peek peek-fly" hidden bind:this={fly}>
  {#each flying?.needs ?? [] as n (n.id)}
    <div class="peek-q">
      {#if settled[n.id]}
        <div class="q-answer"><Icon name="check" size={10} /><span>{firstLine(n.question)} — {settled[n.id]}</span></div>
      {:else}
        <div class="peek-q-meta"><Icon name="hand" size={11} /><b>{n.from}</b><span>{ago(n.createdAt)} ago</span>{#if n.priority !== "normal"}<span class="tag prio-{n.priority}">{n.priority}</span>{/if}</div>
        <div class="peek-q-title">{firstLine(n.question)}</div>
        {#if rest(n.question)}<div class="peek-q-body q-body" {@attach md(rest(n.question))}></div>{/if}
        {#if n.options.length}
          <div class="q-options">{#each n.options as option (option)}<button class="opt" onclick={() => void reply(n, option)}>{option}</button>{/each}</div>
        {/if}
        {#if n.freeText}
          <input class="peek-input" placeholder={n.options.length ? "Or answer in words…" : "Answer…"} bind:value={typed[n.id]} onkeydown={(e) => e.key === "Enter" && !e.isComposing && void reply(n, typed[n.id] ?? "")} />
        {/if}
        <div class="peek-q-foot"><span class="peek-q-note">{notes[n.id] ?? ""}</span><button class="peek-q-open" onclick={() => (peek?.dismiss(), reveal(n))}>Open in chat <Icon name="chevron" size={8} /></button></div>
      {/if}
    </div>
  {/each}
</div>
