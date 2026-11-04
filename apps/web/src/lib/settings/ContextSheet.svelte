<script lang="ts">
  import { untrack } from "svelte";
  import { api } from "../api";
  import { capital } from "../format";
  import type { ContextItem } from "../types";
  import Sheet from "../ui/Sheet.svelte";
  import { BLOCK_TITLE, TEXTAREA } from "./controls";

  /** One context row opened: an editable file saved as it is typed, the tools of a server, or text to read. */
  const SAVE_AFTER_MS = 600;
  let { title, items, onclose }: { title: string; items: readonly ContextItem[]; onclose: () => void } = $props();
  const first = untrack(() => items[0]);
  const editable = untrack(() => (first?.editable && items.length === 1 ? first : undefined));
  const tools = $derived(items.flatMap((i) => i.tools ?? []));

  let text = $state(first?.body ?? "");
  let note = $state("");
  let failed = $state(false);
  let saved = first?.body ?? "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The write in flight, so a flush waits for it instead of writing the same text twice. */
  let writing: Promise<void> | undefined;

  async function write() {
    await writing;
    if (!editable || text === saved) return;
    const sending = text;
    writing = api.saveContext(editable.name, sending).then((result) => {
      failed = Boolean(result.error);
      note = result.error ?? "Saved";
      if (!result.error) saved = sending;
      writing = undefined;
    });
    await writing;
  }
  function typed() {
    clearTimeout(timer);
    timer = setTimeout(() => void write(), SAVE_AFTER_MS);
  }
  function flush() {
    clearTimeout(timer);
    return write();
  }
  // The settings dialog can close the sheet from outside it, which skips `closed`.
  $effect(() => () => void flush());

  async function closed() {
    await flush();
    onclose();
  }
</script>

<Sheet label={title} onclose={() => void closed()}>
  {#snippet head()}
    <div class="flex items-baseline gap-3">
      <h2 class="m-0 min-w-0 flex-1 truncate text-[14px] font-medium">{title}</h2>
      {#if note}<span class="truncate text-[12px] {failed ? 'text-hot' : 'text-ink-45'}" role="status">{note}</span>{/if}
    </div>
  {/snippet}

  {#if editable}
    <textarea class="{TEXTAREA} block h-[60dvh] resize-none" aria-label={title} spellcheck="false" bind:value={text} oninput={typed}></textarea>
  {:else if first?.kind === "tool"}
    {#if tools.length}
      <ul class="m-0 list-none space-y-2 p-0 text-[13px]">
        {#each tools as tool (tool.name)}
          <li>{tool.name}{#if tool.description}<span class="block text-[12px] text-ink-45">{tool.description}</span>{/if}</li>
        {/each}
      </ul>
    {:else}
      <p class="m-0 text-[13px] text-ink-45">{first.description}</p>
    {/if}
  {:else}
    <div class="space-y-4">
      {#each items as item (item.name)}
        <section>
          {#if items.length > 1}<h3 class={BLOCK_TITLE}>{capital(item.name)}</h3>{/if}
          <p class="m-0 text-[13px] whitespace-pre-wrap text-ink-70">{item.body ?? ""}</p>
        </section>
      {/each}
    </div>
  {/if}
</Sheet>
