<script lang="ts">
  import { ChevronRight } from "lucide-svelte";
  import type { Conversation } from "$lib/stores/conversation.svelte";
  import Markdown from "./Markdown.svelte";

  /** The turn in progress: the tool calls folded under one line, the reply as it streams. */
  let { conversation }: { conversation: Conversation } = $props();
  let open = $state(false);
</script>

{#if conversation.working}
  <div class="space-y-2" data-testid="live-turn">
    {#if conversation.tools.length}
      <button class="flex items-center gap-1 text-[12px] text-muted hover:text-ink" onclick={() => (open = !open)}>
        <ChevronRight size={12} class="transition-transform {open ? 'rotate-90' : ''}" />
        {conversation.tools.length} tool {conversation.tools.length === 1 ? "call" : "calls"} · {conversation.tools.at(-1)?.summary || conversation.tools.at(-1)?.name}
      </button>
      {#if open}
        <ul class="space-y-0.5 border-l border-line pl-3 font-mono text-[11px] text-muted">
          {#each conversation.tools as tool (tool.id)}
            <li class={tool.done ? "" : "text-ink"}>{tool.done ? "✓" : "…"} {tool.summary || tool.name}</li>
          {/each}
        </ul>
      {/if}
    {/if}
    {#if conversation.streaming}
      <Markdown text={conversation.streaming} />
    {:else}
      <p class="flex items-center gap-2 text-muted"><span class="size-1.5 animate-pulse rounded-full bg-accent"></span> Working on it…</p>
    {/if}
  </div>
{/if}
