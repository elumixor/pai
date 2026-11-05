<script lang="ts" module>
  import { Brain, CircleCheck, type Icon as LucideIcon, ScrollText, Wrench, Zap } from "lucide-svelte";

  /** The sheet's tabs: what the agent is told, remembers, is tracked on, can do, and what wakes it. */
  export const AGENT_TABS = [
    { id: "instructions", label: "Instructions", icon: ScrollText },
    { id: "memory", label: "Memory", icon: Brain },
    { id: "keep", label: "Keep page", icon: CircleCheck },
    { id: "tools", label: "Tools", icon: Wrench },
    { id: "wakes", label: "Routines & events", icon: Zap },
  ] as const satisfies readonly { id: string; label: string; icon: typeof LucideIcon }[];
  export type AgentTab = (typeof AGENT_TABS)[number]["id"];
</script>

<script lang="ts">
  import { ExternalLink } from "lucide-svelte";
  import { api } from "../api";
  import { md } from "../markdown";
  import { BLOCK_TITLE, ERROR, SKELETON } from "../settings/controls";
  import type { AgentSheet } from "../types";
  import Sheet from "../ui/Sheet.svelte";
  import ConfigLists from "./ConfigLists.svelte";
  import { contextPopup } from "./popups.svelte";

  /** One agent's setup, General's included, a tab per thing the header offers. Read only: Tools says where it changes. */
  let { slug, name, tab: initial, onclose }: { slug: string; name: string; tab: AgentTab; onclose: () => void } = $props();

  // svelte-ignore state_referenced_locally
  let tab = $state<AgentTab>(initial);
  let sheet = $state<AgentSheet | undefined>();
  let error = $state("");
  let box = $state<Sheet>();

  $effect(() => {
    api.agentSheet(slug).then(
      (found) => (sheet = found),
      (e: Error) => (error = e.message),
    );
  });

  async function changeTools() {
    await box?.close();
    contextPopup.open = "tools";
  }
</script>

{#snippet file(item: { name: string; text: string })}
  <section>
    <h3 class="{BLOCK_TITLE} m-0 mb-1.5">{item.name}</h3>
    {#if item.text.trim()}<div class="text-[13px]" {@attach md(item.text)}></div>{:else}<p class="m-0 text-[12px] text-ink-45">Empty.</p>{/if}
  </section>
{/snippet}

<Sheet bind:this={box} label="{name}: {AGENT_TABS.find((t) => t.id === tab)?.label}" {onclose}>
  {#snippet head()}<h2 class="m-0 truncate text-[14px] font-medium">{name}</h2>{/snippet}
  <div class="mb-4 flex flex-wrap gap-1" role="tablist">
    {#each AGENT_TABS as item (item.id)}
      <button
        type="button"
        role="tab"
        aria-selected={tab === item.id}
        class="flex h-7 items-center gap-1.5 rounded-sm px-2 text-[13px] transition-colors {tab === item.id ? 'bg-ink-10 text-ink' : 'text-ink-45 hover:bg-ink-5 hover:text-ink'}"
        onclick={() => (tab = item.id)}
      ><item.icon size={16} /> {item.label}</button>
    {/each}
  </div>
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
      {#if !sheet.page}
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
</Sheet>
