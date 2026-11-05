<script lang="ts">
  import { api } from "../api";
  import { BLOCK_TITLE, ERROR, SKELETON } from "../settings/controls";
  import type { ChatConfig } from "../types";
  import Sheet from "../ui/Sheet.svelte";
  import { contextPopup, type ContextPopup } from "./popups.svelte";

  /** What this one chat is told, what it can call, and what can wake it. Read only: each part links to where it changes. */
  let { session, onclose }: { session?: string; onclose: () => void } = $props();

  const WHO: Readonly<Record<ChatConfig["who"], string>> = {
    general: "General, the orchestrator.",
    thread: "A thread under General.",
    code: "A coding session.",
    worker: "A worker with its own brief and tools.",
  };

  let config = $state<ChatConfig | undefined>();
  let error = $state("");
  let sheet = $state<Sheet>();

  $effect(() => {
    api.chatConfig(session).then((c) => (config = c), (e: Error) => (error = e.message));
  });

  const when = (r: ChatConfig["routines"][number]) => (r.schedule ? `Cron ${r.schedule}` : `On ${config?.events.find((e) => e.kind === r.event)?.title ?? r.event}`);
  const sources = $derived.by(() => {
    const by = new Map<string, ChatConfig["events"][number][]>();
    for (const e of config?.events ?? []) by.set(e.sourceTitle, [...(by.get(e.sourceTitle) ?? []), e]);
    return [...by];
  });

  async function goTo(popup: ContextPopup) {
    await sheet?.close();
    contextPopup.open = popup;
  }
</script>

{#snippet title(text: string, count: number, popup?: ContextPopup)}
  <div class="mb-1.5 flex items-baseline gap-2">
    <h3 class="{BLOCK_TITLE} m-0 flex-1">{text} · {count}</h3>
    {#if popup}<button type="button" class="text-[12px] text-ink-45 hover:text-ink" onclick={() => goTo(popup)}>Change</button>{/if}
  </div>
{/snippet}

<Sheet bind:this={sheet} label="Chat config" {onclose}>
  {#snippet head()}<h2 class="m-0 text-[14px] font-medium">Chat config</h2>{/snippet}
  {#if error}
    <p class={ERROR} role="alert">{error}</p>
  {:else if !config}
    <div class="space-y-2" aria-hidden="true">
      {#each [0, 1, 2] as i (i)}<div class="h-8 {SKELETON}"></div>{/each}
    </div>
  {:else}
    <div class="space-y-6">
      <p class="m-0 text-[13px] text-ink-70">{WHO[config.who]}</p>

      <section>
        {@render title("Instructions", config.instructions.length, "instructions")}
        <ul class="m-0 list-none p-0">
          {#each config.instructions as item (item.name)}
            <li class="border-b border-line py-1.5 last:border-b-0">
              <p class="m-0 text-[13px]">{item.name}{#if item.overridden}<span class="ml-2 text-[11px] text-ink-45">Edited</span>{/if}</p>
              <p class="m-0 text-[12px] text-ink-45">{item.what}</p>
            </li>
          {/each}
        </ul>
      </section>

      <section>
        {@render title("Tools", config.tools.length, "tools")}
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
    </div>
  {/if}
</Sheet>
