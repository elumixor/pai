<script lang="ts" module>
  import { Brain, ScrollText, Wrench, Zap } from "lucide-svelte";
  import KeepLogo from "../ui/KeepLogo.svelte";

  /** The panel's tabs: what the agent is told, remembers, is tracked on, can do, and what wakes it. */
  export const AGENT_TABS = [
    { id: "instructions", label: "Instructions", icon: ScrollText },
    { id: "memory", label: "Memory", icon: Brain },
    { id: "keep", label: "Keep", icon: KeepLogo },
    { id: "tools", label: "Tools", icon: Wrench },
    { id: "wakes", label: "Events", icon: Zap },
  ] as const;
  export type AgentTab = (typeof AGENT_TABS)[number]["id"];
</script>

<script lang="ts">
  import { ExternalLink, X } from "lucide-svelte";
  import { fade } from "svelte/transition";
  import { api } from "../api";
  import { md } from "../markdown";
  import { BLOCK_TITLE, ERROR, SKELETON } from "../settings/controls";
  import type { AgentSheet } from "../types";
  import ConfigLists from "./ConfigLists.svelte";
  import { contextPopup } from "./popups.svelte";

  /**
   * One agent's setup, General's included, read only: Tools says where it changes. The page's bar picks the tab; a phone
   * has one button there, so the tabs are here too.
   */
  let { slug, tab = $bindable(), onclose }: { slug: string; tab: AgentTab; onclose: () => void } = $props();

  const SWITCH_MS = 120;
  let sheet = $state<AgentSheet | undefined>();
  let error = $state("");
  const label = $derived(AGENT_TABS.find((t) => t.id === tab)?.label);

  // The panel stays open from agent to agent: an answer for the last one must not land on this one.
  $effect(() => {
    let current = true;
    sheet = undefined;
    error = "";
    api.agentSheet(slug).then(
      (found) => current && (sheet = found),
      (e: Error) => current && (error = e.message),
    );
    return () => {
      current = false;
    };
  });

  function changeTools() {
    onclose();
    contextPopup.open = "tools";
  }
</script>

{#snippet file(item: { name: string; text: string })}
  <section>
    <h3 class="{BLOCK_TITLE} m-0 mb-1.5">{item.name}</h3>
    {#if item.text.trim()}<div class="text-[13px]" {@attach md(item.text)}></div>{:else}<p class="m-0 text-[12px] text-ink-45">Empty.</p>{/if}
  </section>
{/snippet}

<div class="flex h-full flex-col" role="region" aria-label={label}>
  <header class="flex h-11 shrink-0 items-center gap-2 border-b border-line pr-3 pl-5 max-sm:pl-4">
    <h2 class="m-0 min-w-0 flex-1 truncate text-[14px] font-medium max-md:hidden">{label}</h2>
    <div class="flex min-w-0 flex-1 gap-1 md:hidden" role="tablist">
      {#each AGENT_TABS as item (item.id)}
        <button
          type="button"
          role="tab"
          aria-label={item.label}
          aria-selected={tab === item.id}
          class="flex h-7 items-center gap-1.5 rounded-sm px-1.5 text-[13px] transition-colors {tab === item.id ? 'bg-ink-10 text-ink' : 'text-ink-45 hover:bg-ink-5 hover:text-ink'}"
          onclick={() => (tab = item.id)}
        ><item.icon size={16} />{#if tab === item.id}<span class="truncate">{item.label}</span>{/if}</button>
      {/each}
    </div>
    <button type="button" class="grid size-7 shrink-0 place-items-center rounded-sm text-ink-45 transition-colors hover:bg-ink-5 hover:text-ink" aria-label="Close" onclick={onclose}><X size={16} /></button>
  </header>
  {#key tab}
    <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4 max-sm:px-4" in:fade={{ duration: SWITCH_MS }}>
      {#if error}
        <p class={ERROR} role="alert">{error}</p>
      {:else if !sheet}
        <div class="space-y-2" aria-hidden="true">
          {#each [0, 1, 2] as i (i)}<div class="h-8 {SKELETON}"></div>{/each}
        </div>
      {:else if tab === "instructions"}
        <div class="space-y-6">
          {#each sheet.instructions.files as item (item.name)}{@render file(item)}{/each}
          <section>
            <h3 class="{BLOCK_TITLE} m-0 mb-1.5">Told in every session · {sheet.instructions.sections.length}</h3>
            <ul class="m-0 list-none p-0">
              {#each sheet.instructions.sections as item (item.name)}
                <li class="border-b border-line py-1.5 last:border-b-0">
                  <p class="m-0 text-[13px]">{item.name}{#if item.overridden}<span class="ml-2 text-[11px] text-ink-45">Edited</span>{/if}</p>
                  <p class="m-0 text-[12px] text-ink-45">{item.what}</p>
                </li>
              {/each}
            </ul>
          </section>
          <details class="text-[13px]">
            <summary class="cursor-pointer text-ink-45">The whole prompt as sent</summary>
            <pre class="m-0 mt-2 overflow-x-auto text-[12px] whitespace-pre-wrap">{sheet.instructions.system}</pre>
          </details>
        </div>
      {:else if tab === "memory"}
        <div class="space-y-6">
          {#each sheet.memory as item (item.name)}{@render file(item)}{/each}
        </div>
      {:else if tab === "keep"}
        <div class="space-y-6">
          {#if sheet.agent.kind === "orchestrator"}
            <section>
              <h3 class="{BLOCK_TITLE} m-0 mb-1.5">Assigned · {sheet.assigned.length}</h3>
              {#if sheet.assigned.length}
                <ul class="m-0 list-none space-y-1 p-0 text-[13px]">
                  {#each sheet.assigned as page (page.urn)}
                    <li class="flex items-baseline gap-2">
                      <a class="min-w-0 flex-1 truncate hover:underline" href={page.url} target="_blank" rel="noreferrer">{page.title}</a>
                      <span class="shrink-0 text-[12px] text-ink-45">{page.workspace}</span>
                    </li>
                  {/each}
                </ul>
              {:else}
                <p class="m-0 text-[13px] text-ink-45">Assign a Keep page to Pai and it shows here.</p>
              {/if}
            </section>
          {:else if !sheet.page}
            <p class="m-0 text-[13px] text-ink-45">No Keep page yet: it is being set up.</p>
          {:else if sheet.page.error}
            <p class={ERROR} role="alert">{sheet.page.urn}: {sheet.page.error}</p>
          {:else}
            <section>
              <div class="mb-1.5 flex items-baseline gap-2">
                <h3 class="m-0 min-w-0 flex-1 truncate text-[14px] font-medium">{sheet.page.title}</h3>
                <a class="flex shrink-0 items-center gap-1 text-[12px] text-ink-45 hover:text-ink" href={sheet.page.url} target="_blank" rel="noreferrer"><ExternalLink size={12} /> Open in Keep</a>
              </div>
              {#if sheet.page.path?.length}<p class="m-0 mb-2 truncate text-[12px] text-ink-45">{sheet.page.path.join(" › ")}</p>{/if}
              <div class="text-[13px]" {@attach md(sheet.page.body ?? "")}></div>
            </section>
          {/if}
          <section>
            <h3 class="{BLOCK_TITLE} m-0 mb-1.5">Connected workspaces · {sheet.keep.workspaces.length + sheet.keep.shared.length}</h3>
            {#if sheet.keep.error}<p class={ERROR} role="alert">{sheet.keep.error}</p>{/if}
            <ul class="m-0 list-none p-0">
              {#each [...sheet.keep.workspaces, ...sheet.keep.shared] as workspace (workspace.id)}
                <li class="border-b border-line py-1.5 last:border-b-0">
                  <p class="m-0 flex items-baseline gap-2 text-[13px]">
                    {#if workspace.url}<a class="min-w-0 flex-1 truncate hover:underline" href={workspace.url} target="_blank" rel="noreferrer">{workspace.icon ?? ""} {workspace.title}</a>{:else}<span class="min-w-0 flex-1 truncate">{workspace.icon ?? ""} {workspace.title}</span>{/if}
                    <span class="shrink-0 text-[12px] text-ink-45">{workspace.role}</span>
                  </p>
                </li>
              {/each}
            </ul>
          </section>
        </div>
      {:else}
        <div class="space-y-6">
          <ConfigLists show={tab} config={sheet} change={changeTools} />
        </div>
      {/if}
    </div>
  {/key}
</div>
