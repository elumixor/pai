<script lang="ts">
  import { api } from "$lib/api";
  import Page from "$lib/components/Page.svelte";
  import { agents } from "$lib/stores/agents.svelte";
  import { live } from "$lib/stores/live.svelte";
  import { notices } from "$lib/stores/notices.svelte";
  import type { Need, TaskItem, TaskStatus } from "$lib/types";

  const GROUPS: readonly { title: string; statuses: readonly TaskStatus[] }[] = [
    { title: "Waiting on me", statuses: ["waiting_user"] },
    { title: "Working", statuses: ["active", "inbox", "waiting_other"] },
    { title: "Scheduled", statuses: ["scheduled"] },
    { title: "Done", statuses: ["done"] },
  ];
  const DONE_SHOWN = 15;

  let tasks = $state<TaskItem[] | null>(null);
  let needs = $state<Need[]>([]);

  async function load() {
    try {
      const [list, open] = await Promise.all([api.tasks(), api.needs()]);
      tasks = list.items ?? [];
      needs = open;
    } catch (error) {
      notices.error(error);
    }
  }

  $effect(() => {
    void load();
    live.start();
    agents.start();
    const off = live.on((event) => event.kind.startsWith("task.") && void load());
    return () => off();
  });

  const needFor = (task: TaskItem) => needs.find((n) => n.taskId === task.id && (n.kind === "task" || n.kind === "ask"));

  async function answer(need: Need, text: string) {
    try {
      await api.answerNeed(need.id, text);
      await load();
    } catch (error) {
      notices.error(error);
    }
  }
</script>

<Page title="Tasks">
  {#if !tasks}
    <div class="space-y-2">{#each [1, 2, 3, 4] as row (row)}<div class="h-10 animate-pulse bg-sunken"></div>{/each}</div>
  {:else}
    {#each GROUPS as group (group.title)}
      {@const rows = tasks.filter((t) => group.statuses.includes(t.status)).slice(0, group.title === "Done" ? DONE_SHOWN : undefined)}
      <section data-testid="tasks-{group.title}">
        <h2 class="mb-2 text-[12px] font-semibold tracking-wide text-muted uppercase">{group.title} <span class="font-mono text-faint">{rows.length}</span></h2>
        {#if !rows.length}
          <p class="text-[14px] text-faint">Nothing.</p>
        {:else}
          <ul class="divide-y divide-line border border-line">
            {#each rows as task (task.id)}
              {@const need = needFor(task)}
              <li class="px-3 py-2.5">
                <div class="flex items-center gap-2">
                  <span class="min-w-0 flex-1 truncate {task.status === 'done' ? 'text-muted line-through' : 'font-medium'}">{task.title}</span>
                  <span class="shrink-0 text-[12px] text-faint">{agents.name(task.owner)}</span>
                </div>
                {#if task.nextAction && task.status !== "done"}<p class="mt-0.5 text-[13px] text-muted">{task.nextAction}</p>{/if}
                {#if need}
                  <div class="mt-2 flex flex-wrap gap-2">
                    {#each need.options as option (option)}
                      <button class="rounded-full border border-line px-3 py-0.5 text-[13px] hover:border-ink" onclick={() => answer(need, option)}>{option}</button>
                    {/each}
                  </div>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/each}
  {/if}
</Page>
