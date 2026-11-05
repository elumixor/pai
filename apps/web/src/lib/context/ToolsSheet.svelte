<script lang="ts">
  import { ArrowLeft, Plus } from "lucide-svelte";
  import { api } from "../api";
  import { BLOCK_TITLE, BUTTON, ERROR, SKELETON } from "../settings/controls";
  import type { ToolProvider, ToolProviders } from "../types";
  import Sheet from "../ui/Sheet.svelte";
  import Switch from "../ui/Switch.svelte";
  import AddServer from "./AddServer.svelte";
  import Panes from "./Panes.svelte";

  /** Every tool provider sessions could have, with what it is, where it comes from, and switches. */
  let { onclose }: { onclose: () => void } = $props();

  const GROUPS = [
    { source: "builtin", title: "Claude Code" },
    { source: "pai", title: "pai" },
    { source: "connector", title: "Connectors" },
    { source: "direct", title: "Added here" },
    { source: "claude.ai", title: "From claude.ai" },
  ] as const;

  let data = $state<ToolProviders | undefined>();
  let error = $state("");
  let openName = $state<string | undefined>();
  let adding = $state<{ name: string; url: string; auth: "none" | "bearer" | "oauth"; replaces?: string } | undefined>();

  const open = $derived(data?.providers.find((p) => p.name === openName));
  const count = (p: ToolProvider) => (p.tools.length ? `${p.tools.filter((t) => t.on).length}/${p.tools.length}` : "");

  const run = (work: Promise<ToolProviders>) =>
    work.then(
      (next) => {
        data = next;
        error = "";
      },
      (e: Error) => (error = e.message),
    );
  $effect(() => void run(api.tools()));

  const moveForm = (p: ToolProvider) => p.move && (adding = { name: p.move.name, url: p.move.url, auth: p.move.auth, replaces: p.name });
</script>

<Sheet label="Tools" wide {onclose}>
  {#snippet head()}
    <div class="flex items-center gap-2">
      {#if open}<button type="button" class="hidden size-8 place-items-center rounded-sm text-ink-45 hover:bg-ink-5 max-md:grid" aria-label="Back to the list" onclick={() => (openName = undefined)}><ArrowLeft size={16} /></button>{/if}
      <h2 class="m-0 text-[14px] font-medium">Tools</h2>
    </div>
  {/snippet}
  {#if !data}
    <div class="w-full space-y-2 p-5" aria-hidden="true">
      {#each [0, 1, 2, 3] as i (i)}<div class="h-8 {SKELETON}"></div>{/each}
      {#if error}<p class={ERROR} role="alert">{error}</p>{/if}
    </div>
  {:else}
    <Panes detailOpen={Boolean(open || adding)}>
      {#snippet list()}
        {#each GROUPS as group (group.source)}
          {@const rows = data!.providers.filter((p) => p.source === group.source)}
          {#if rows.length || group.source === "claude.ai" || group.source === "direct"}
            <section class="mb-3">
              <div class="flex min-h-7 items-center gap-2 px-4">
                <h3 class="{BLOCK_TITLE} m-0 flex-1">{group.title}</h3>
                {#if group.source === "claude.ai"}
                  <Switch checked={data!.claudeSync} label="Sync connectors from claude.ai" onchange={(on) => run(api.patchTools({ claudeSync: on }))} />
                {:else if group.source === "direct"}
                  <button type="button" class="grid size-6 place-items-center rounded-sm text-ink-45 hover:bg-ink-5" aria-label="Add a server" onclick={() => { openName = undefined; adding = { name: "", url: "", auth: "bearer" }; }}><Plus size={14} /></button>
                {/if}
              </div>
              {#if group.source === "claude.ai" && !data!.claudeSync}
                <p class="m-0 px-4 text-[12px] text-ink-45">Off: no session gets a claude.ai connector.</p>
              {/if}
              <ul class="m-0 list-none p-0">
                {#each rows as p (p.name)}
                  <li class="flex items-center gap-2 pr-4 {openName === p.name ? 'bg-ink-5' : ''}">
                    <button type="button" class="flex min-h-9 min-w-0 flex-1 items-center gap-2 pl-4 text-left text-[13px] {p.on ? '' : 'text-ink-45'}" onclick={() => { adding = undefined; openName = p.name; }}>
                      <span class="min-w-0 flex-1 truncate">{p.name.replace(/^claude\.ai /, "")}</span>
                      {#if p.on && !p.healthy}<span class="shrink-0 text-[11px] text-hot">{p.status}</span>
                      {:else}<span class="shrink-0 text-[12px] text-ink-45 tabular-nums">{count(p)}</span>{/if}
                    </button>
                    {#if !p.required}<Switch checked={p.on} label="{p.name} on" onchange={(on) => run(api.patchTools({ server: p.name, on }))} />{/if}
                  </li>
                {/each}
              </ul>
            </section>
          {/if}
        {/each}
      {/snippet}
      {#snippet detail()}
        {#if adding}
          <AddServer draft={adding} oncancel={() => (adding = undefined)} ondone={(next) => { data = next; adding = undefined; }} />
        {:else if open}
          <div class="space-y-4 p-5 max-sm:p-4">
            <header class="space-y-1">
              <h3 class="m-0 text-[15px] font-medium">{open.name}</h3>
              <p class="m-0 text-[13px] text-ink-70">{open.what}</p>
              <p class="m-0 text-[12px] text-ink-45">{open.origin}</p>
              <p class="m-0 text-[12px] {open.on && !open.healthy ? 'text-hot' : 'text-ink-45'}">{open.status}</p>
            </header>
            {#if error}<p class={ERROR} role="alert">{error}</p>{/if}
            <div class="flex flex-wrap gap-2 empty:hidden">
              {#if open.move}<button type="button" class={BUTTON} onclick={() => moveForm(open!)}>Move to pai</button>{/if}
              {#if open.direct}<button type="button" class={BUTTON} onclick={() => run(api.removeServer(open!.name))}>{open.direct.replaces ? "Back to sync" : "Remove"}</button>{/if}
            </div>
            {#if open.tools.length}
              <ul class="m-0 list-none p-0">
                {#each open.tools as tool (tool.full)}
                  <li class="flex items-start gap-3 border-b border-line py-2 last:border-b-0">
                    <div class="min-w-0 flex-1 {tool.on && open.on ? '' : 'opacity-50'}">
                      <p class="m-0 font-mono text-[12px]">{tool.name}</p>
                      {#if tool.description}<p class="m-0 mt-0.5 line-clamp-3 text-[12px] text-ink-45">{tool.description}</p>{/if}
                    </div>
                    <Switch checked={tool.on} disabled={!open.on} label="{tool.name} on" onchange={(on) => run(api.patchTools({ tool: tool.full, on }))} />
                  </li>
                {/each}
              </ul>
            {:else}
              <p class="m-0 text-[13px] text-ink-45">Its tools show once a session has started with it.</p>
            {/if}
          </div>
        {:else}
          <div class="grid flex-1 place-items-center p-8 text-center"><p class="m-0 max-w-80 text-[13px] text-ink-45">Pick a provider to see what it is and what it offers. What is switched off here, no session gets. Changes apply on each session's next turn.</p></div>
        {/if}
      {/snippet}
    </Panes>
  {/if}
</Sheet>
