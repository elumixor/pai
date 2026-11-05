<script lang="ts">
  import { ArrowLeft } from "lucide-svelte";
  import { api } from "../api";
  import { BLOCK_TITLE, BUTTON, ERROR, SKELETON } from "../settings/controls";
  import type { ContextItem } from "../types";
  import Sheet from "../ui/Sheet.svelte";
  import MarkdownField from "./MarkdownField.svelte";
  import Panes from "./Panes.svelte";

  /** What sessions are told: memory, the persona, each built-in section, and the whole prompt as it is sent. */
  let { onclose }: { onclose: () => void } = $props();

  const AUDIENCES = [
    { who: "general", label: "General" },
    { who: "thread", label: "Thread" },
    { who: "code", label: "Code session" },
    { who: "worker", label: "Worker" },
  ] as const;
  type Audience = (typeof AUDIENCES)[number]["who"];
  const PREVIEW = "preview";

  let items = $state<ContextItem[] | undefined>();
  let error = $state("");
  let openName = $state<string | undefined>();
  let audience = $state<Audience>("general");
  let prompt = $state("");
  /** Reset swaps the text under a mounted editor, so the field is rebuilt around it. */
  let revision = $state(0);

  const load = () => api.context().then((d) => (items = d.items.filter((i) => i.kind === "instruction" || i.kind === "memory")), (e: Error) => (error = e.message));
  $effect(() => void load());
  $effect(() => {
    if (openName === PREVIEW) void api.contextPrompt(audience).then((d) => (prompt = d.text), (e: Error) => (error = e.message));
  });

  const open = $derived(items?.find((i) => i.name === openName));
  const groups = $derived.by(() => {
    const all = items ?? [];
    return [
      { title: "Yours", rows: all.filter((i) => i.name === "Memory" || i.name === "Persona") },
      { title: "Built in", rows: all.filter((i) => i.id) },
      { title: "From connectors", rows: all.filter((i) => i.connector) },
      { title: "No longer loaded", rows: all.filter((i) => i.kind === "memory" && i.name !== "Memory") },
    ].filter((g) => g.rows.length);
  });

  async function reset(name: string) {
    const result = await api.resetContext(name);
    if (result.error) return void (error = result.error);
    await load();
    revision += 1;
  }
</script>

<Sheet label="Instructions" wide {onclose}>
  {#snippet head()}
    <div class="flex items-center gap-2">
      {#if openName}<button type="button" class="hidden size-8 place-items-center rounded-sm text-ink-45 hover:bg-ink-5 max-md:grid" aria-label="Back to the list" onclick={() => (openName = undefined)}><ArrowLeft size={16} /></button>{/if}
      <h2 class="m-0 text-[14px] font-medium">Instructions</h2>
    </div>
  {/snippet}
  {#if !items}
    <div class="w-full space-y-2 p-5" aria-hidden="true">
      {#each [0, 1, 2] as i (i)}<div class="h-8 {SKELETON}"></div>{/each}
      {#if error}<p class={ERROR} role="alert">{error}</p>{/if}
    </div>
  {:else}
    <Panes detailOpen={Boolean(openName)}>
      {#snippet list()}
        <div class="px-4 pb-2"><button type="button" class="{BUTTON} w-full justify-center" onclick={() => (openName = PREVIEW)}>See the whole prompt</button></div>
        {#each groups as group (group.title)}
          <section class="mb-3">
            <h3 class="{BLOCK_TITLE} px-4">{group.title}</h3>
            <ul class="m-0 list-none p-0">
              {#each group.rows as item (item.name)}
                <li class={openName === item.name ? "bg-ink-5" : ""}>
                  <button type="button" class="flex min-h-9 w-full items-center gap-2 px-4 text-left text-[13px]" onclick={() => (openName = item.name)}>
                    <span class="min-w-0 flex-1 truncate">{item.name}</span>
                    {#if item.overridden}<span class="shrink-0 text-[11px] text-ink-45">Edited</span>{/if}
                  </button>
                </li>
              {/each}
            </ul>
          </section>
        {/each}
      {/snippet}
      {#snippet detail()}
        {#if openName === PREVIEW}
          <div class="flex min-h-0 flex-1 flex-col gap-3 p-5 max-sm:p-4">
            <h3 class="m-0 text-[15px] font-medium">The whole prompt</h3>
            <p class="m-0 text-[12px] text-ink-45">Exactly what is added to Claude Code's own system prompt, in order. Each session type gets a different mix.</p>
            <div class="flex flex-wrap gap-1" role="radiogroup" aria-label="Session type">
              {#each AUDIENCES as a (a.who)}
                <button type="button" role="radio" aria-checked={audience === a.who} class="h-7 rounded-sm px-2.5 text-[12px] {audience === a.who ? 'bg-ink-10 text-ink' : 'text-ink-45 hover:bg-ink-5'}" onclick={() => (audience = a.who)}>{a.label}</button>
              {/each}
            </div>
            <pre class="m-0 min-h-0 flex-1 overflow-y-auto font-mono text-[12px] leading-5 break-words whitespace-pre-wrap text-ink-70">{prompt}</pre>
          </div>
        {:else if open}
          {@const item = open}
          <div class="flex min-h-0 flex-1 flex-col gap-3 p-5 max-sm:p-4">
            <header class="space-y-1">
              <div class="flex items-center gap-2">
                <h3 class="m-0 min-w-0 flex-1 truncate text-[15px] font-medium">{item.name}</h3>
                {#if item.overridden}<button type="button" class={BUTTON} onclick={() => reset(item.name)}>Reset to default</button>{/if}
              </div>
              {#if item.what}<p class="m-0 text-[13px] text-ink-70">{item.what}</p>{/if}
              {#if item.goesTo}<p class="m-0 text-[12px] text-ink-45">Goes to: {item.goesTo}</p>{/if}
            </header>
            {#if error}<p class={ERROR} role="alert">{error}</p>{/if}
            {#key `${item.name}:${revision}`}
              <MarkdownField value={item.body ?? ""} label={item.name} readonly={!item.editable} save={item.editable ? (text) => api.saveContext(item.name, text).then((r) => r.error) : undefined} onsaved={() => void load()} />
            {/key}
          </div>
        {:else}
          <div class="grid flex-1 place-items-center p-8 text-center"><p class="m-0 max-w-80 text-[13px] text-ink-45">Everything pai is told, piece by piece. Open one to read what it does and who gets it, and to change it.</p></div>
        {/if}
      {/snippet}
    </Panes>
  {/if}
</Sheet>
