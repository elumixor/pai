<script lang="ts">
  import { BLOCK_TITLE } from "../settings/controls";
  import type { ChatConfig } from "../types";

  /** What a chat can call, and what can wake it, read only: the same lists wherever a chat's setup shows. */
  let { show, config, change }: { show: "tools" | "wakes"; config: Pick<ChatConfig, "tools" | "routines" | "events">; change?: () => void } = $props();

  const when = (r: ChatConfig["routines"][number]) => (r.schedule ? `Cron ${r.schedule}` : `On ${config.events.find((e) => e.kind === r.event)?.title ?? r.event}`);
  const sources = $derived.by(() => {
    const by = new Map<string, ChatConfig["events"][number][]>();
    for (const e of config.events) by.set(e.sourceTitle, [...(by.get(e.sourceTitle) ?? []), e]);
    return [...by];
  });
</script>

{#snippet title(text: string, count: number, onchange?: () => void)}
  <div class="mb-1.5 flex items-baseline gap-2">
    <h3 class="{BLOCK_TITLE} m-0 flex-1">{text} · {count}</h3>
    {#if onchange}<button type="button" class="text-[12px] text-ink-45 hover:text-ink" onclick={onchange}>Change</button>{/if}
  </div>
{/snippet}

{#if show === "tools"}
  <section>
    {@render title("Tools", config.tools.length, change)}
    <ul class="m-0 list-none p-0">
      {#each config.tools as tool (tool.name)}
        <li class="border-b border-line py-1.5 last:border-b-0">
          <p class="m-0 flex items-baseline gap-2 text-[13px]">
            <span class="min-w-0 flex-1 truncate">{tool.name}</span>
            {#if !tool.healthy}<span class="shrink-0 text-[11px] text-hot">{tool.status}</span>{:else if tool.count}<span class="shrink-0 text-[12px] text-ink-45 tabular-nums">{tool.count}</span>{/if}
          </p>
          <p class="m-0 text-[12px] text-ink-45">{tool.what}</p>
        </li>
      {/each}
    </ul>
  </section>
{:else}
  <section>
    {@render title("Routines", config.routines.length)}
    {#if config.routines.length}
      <ul class="m-0 list-none p-0">
        {#each config.routines as routine (routine.id)}
          <li class="border-b border-line py-1.5 last:border-b-0 {routine.enabled ? '' : 'opacity-50'}">
            <p class="m-0 text-[13px]">{routine.name}</p>
            <p class="m-0 text-[12px] text-ink-45">{when(routine)} · {routine.action}{routine.enabled ? "" : " · off"}</p>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="m-0 text-[12px] text-ink-45">None wake this chat.</p>
    {/if}
  </section>

  <section>
    {@render title("Events a routine can react to", config.events.length)}
    {#each sources as [source, events] (source)}
      <details class="border-b border-line py-1.5 text-[13px] last:border-b-0">
        <summary class="cursor-pointer">{source} <span class="text-[12px] text-ink-45 tabular-nums">{events.length}</span></summary>
        <ul class="m-0 mt-1 list-none space-y-1 p-0">
          {#each events as event (event.kind)}
            <li class="text-[12px]">{event.title}<span class="block text-ink-45">{event.description}</span></li>
          {/each}
        </ul>
      </details>
    {/each}
  </section>
{/if}
