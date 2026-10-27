<script lang="ts">
  import { desk } from "../desk.svelte";
  import type { IconName } from "../icons";
  import { recall, remember } from "../storage";
  import type { TaskItem, TaskStatus } from "../types";
  import Icon from "../ui/Icon.svelte";

  /**
   * An agent's desk: its tasks as a list, grouped by state the way a Notion list view groups by status — a fold
   * triangle, the state's name and how many, a row per task, with the sub-agents' tasks on it too (a pill says whose)
   * and the due date as a pill. Only the states with tasks are drawn; done is folded until opened.
   */
  let { slug, under, openTask, newTask }: { slug: string; under: (owner: string) => boolean; openTask: (id: number) => void; newTask: () => void } = $props();

  type Group = "scheduled" | "working" | "decision" | "done";
  const GROUPS: readonly { id: Group; label: string; statuses: readonly TaskStatus[]; folded?: boolean }[] = [
    { id: "scheduled", label: "Scheduled", statuses: ["inbox", "scheduled"] },
    { id: "working", label: "Working", statuses: ["active", "waiting_other"] },
    { id: "decision", label: "Decision", statuses: ["waiting_user"] },
    { id: "done", label: "Done", statuses: ["done", "dropped"], folded: true },
  ];
  const MARK: Record<TaskStatus, IconName> = { waiting_user: "hand", active: "play", inbox: "circle", scheduled: "clock", waiting_other: "hourglass", done: "circleCheck", dropped: "x" };
  const DAY_MS = 86_400_000;
  const OPEN: readonly TaskStatus[] = ["inbox", "scheduled", "active", "waiting_other", "waiting_user"];
  const foldKey = $derived(`pai.tasks.folded.${slug}`);
  // svelte-ignore state_referenced_locally
  let folded = $state(new Set<Group>(recall<Group[]>(foldKey, GROUPS.filter((g) => g.folded).map((g) => g.id))));

  /** A due date as a person says it: Today, Tomorrow, Yesterday, a weekday within the week, else the date. */
  function dueLabel(due: string) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const [y, m, d] = due.split("-").map(Number);
    const day = y && m && d ? new Date(y, m - 1, d) : new Date(due);
    if (Number.isNaN(day.getTime())) return due;
    const days = Math.round((day.getTime() - today.getTime()) / DAY_MS);
    if (days === 0) return "Today";
    if (days === 1) return "Tomorrow";
    if (days === -1) return "Yesterday";
    if (days > 1 && days < 7) return day.toLocaleDateString(undefined, { weekday: "long" });
    return day.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(day.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) });
  }
  const late = (t: TaskItem) => Boolean(t.due && OPEN.includes(t.status) && new Date(t.due).getTime() < Date.now() - DAY_MS);

  const mine = $derived(
    Object.values(desk.taskIndex)
      .filter((t) => under(t.owner))
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)),
  );
  const groups = $derived(GROUPS.map((g) => ({ ...g, items: mine.filter((t) => g.statuses.includes(t.status)) })).filter((g) => g.items.length));

  function fold(id: Group) {
    const next = new Set(folded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    folded = next;
    remember(foldKey, JSON.stringify([...next]));
  }
</script>

<div class="agent-view">
  <section class="agent-tasks" data-testid="desk">
    <div class="agent-tasks-body">
      {#each groups as g (g.id)}
        {@const open = !folded.has(g.id)}
        <div class="desk-group" class:folded={!open} data-testid="desk-{g.id}">
          <button class="desk-group-head" class:open onclick={() => fold(g.id)}><Icon name="chevron" size={11} /><span>{g.label}</span><span class="desk-group-count">{g.items.length}</span></button>
          {#if open}
            <div class="desk-group-rows">
              {#each g.items as t (t.id)}
                <button class="desk-row status-{t.status}" title={t.nextAction || undefined} onclick={() => openTask(t.id)}>
                  {#if t.status === "active" && desk.bySlug(t.owner)?.status === "working"}<span class="spinner"></span>{:else}<Icon name={MARK[t.status]} size={14} />{/if}
                  <span class="desk-row-title">{t.title}</span>
                  {#if t.owner !== slug}<span class="desk-pill agent" title="whose task it is">{desk.nameOf(t.owner)}</span>{/if}
                  {#if t.due}<span class="desk-pill due" class:late={late(t)} title={t.due}>{dueLabel(t.due)}</span>{/if}
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {:else}
        <p class="desk-empty">{desk.loaded ? "No tasks." : "…"}</p>
      {/each}
    </div>
    <button class="desk-new" title="ask for a task in words" onclick={newTask}><Icon name="plus" size={12} /><span>New task</span></button>
  </section>
</div>
