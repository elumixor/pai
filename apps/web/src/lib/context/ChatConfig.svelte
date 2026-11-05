<script lang="ts">
  import { api } from "../api";
  import { BLOCK_TITLE, ERROR, SKELETON } from "../settings/controls";
  import type { ChatConfig } from "../types";
  import Sheet from "../ui/Sheet.svelte";
  import ConfigLists from "./ConfigLists.svelte";
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

      <ConfigLists show="tools" {config} change={() => goTo("tools")} />
      <ConfigLists show="wakes" {config} />
    </div>
  {/if}
</Sheet>
