<script lang="ts">
  import { page } from "$app/state";
  import type { AgentNode } from "$lib/stores/agents.svelte";
  import AgentItem from "./AgentItem.svelte";

  let { node, depth = 1 }: { node: AgentNode; depth?: number } = $props();
  const active = $derived(page.url.hash === `#/agent/${node.agent.slug}`);
</script>

<a
  href="#/agent/{node.agent.slug}"
  class="flex h-8 items-center gap-2 pr-2 text-[14px] {active ? 'bg-sunken font-semibold' : 'text-muted hover:bg-sunken hover:text-ink'}"
  style="padding-left: {depth * 14 + 10}px"
>
  <span class="size-1.5 shrink-0 rounded-full {node.agent.status === 'working' ? 'animate-pulse bg-accent' : node.agent.status === 'waiting' ? 'bg-danger' : 'bg-faint'}"></span>
  <span class="truncate">{node.agent.name}</span>
  {#if node.agent.openTasks}<span class="ml-auto font-mono text-[11px] text-faint">{node.agent.openTasks}</span>{/if}
</a>
{#each node.children as child (child.agent.slug)}
  <AgentItem node={child} depth={depth + 1} />
{/each}
