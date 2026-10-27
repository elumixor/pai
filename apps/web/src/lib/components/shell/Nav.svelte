<script lang="ts">
  import { BookOpen, ListChecks, LogOut, MessageCircle, Moon, Plug, Sun } from "lucide-svelte";
  import { page } from "$app/state";
  import { auth } from "$lib/auth.svelte";
  import { agents } from "$lib/stores/agents.svelte";
  import { theme } from "$lib/stores/theme.svelte";
  import AgentItem from "./AgentItem.svelte";

  let { onnavigate = () => {} }: { onnavigate?: () => void } = $props();
  const hash = $derived(page.url.hash || "#/");
  const link = (to: string) => `flex h-9 items-center gap-2.5 px-3 text-[14px] ${hash === to ? "bg-sunken font-semibold text-ink" : "text-muted hover:bg-sunken hover:text-ink"}`;

  $effect(() => agents.start());
</script>

<nav class="flex h-full flex-col" aria-label="pai" onclickcapture={(e) => (e.target as HTMLElement).closest("a") && onnavigate()}>
  <div class="px-3 pt-3 pb-2"><desk-bar></desk-bar></div>
  <a class={link("#/")} href="#/"><MessageCircle size={16} /> Chat</a>
  <div class="min-h-0 flex-1 overflow-y-auto py-1" aria-label="Threads">
    {#each agents.tree as node (node.agent.slug)}
      <AgentItem {node} />
    {/each}
  </div>
  <div class="border-t border-line py-2">
    <a class={link("#/tasks")} href="#/tasks"><ListChecks size={16} /> Tasks</a>
    <a class={link("#/connectors")} href="#/connectors"><Plug size={16} /> Connectors</a>
    <a class={link("#/skills")} href="#/skills"><BookOpen size={16} /> Skills</a>
  </div>
  <div class="flex items-center gap-1 border-t border-line p-2">
    <button class="flex items-center gap-2 px-2 py-1.5 text-[13px] text-muted hover:text-ink" onclick={() => auth.signOut()}><LogOut size={14} /> Sign out</button>
    <button class="ml-auto grid size-8 place-items-center text-muted hover:text-ink" aria-label="Switch theme" onclick={() => theme.toggle()}>
      {#if theme.dark}<Sun size={15} />{:else}<Moon size={15} />{/if}
    </button>
  </div>
</nav>
