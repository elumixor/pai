<script lang="ts">
  import { api } from "$lib/api";
  import { notices } from "$lib/stores/notices.svelte";
  import type { LogMessage } from "$lib/types";
  import Markdown from "./Markdown.svelte";

  /** An agent asking the user something: its options as buttons, a free answer when it allows one. */
  let { message, answered }: { message: LogMessage; answered: boolean } = $props();
  let text = $state("");
  let sending = $state(false);

  async function answer(reply: string) {
    const askId = message.meta.askId;
    if (!askId || !reply.trim()) return;
    sending = true;
    try {
      await api.answerAsk(askId, reply.trim());
      text = "";
    } catch (error) {
      notices.error(error);
    } finally {
      sending = false;
    }
  }
</script>

<div class="border border-accent/40 bg-accent-soft/40 px-4 py-3" data-testid="ask">
  <p class="mb-1 text-[12px] font-semibold tracking-wide text-accent uppercase">{answered ? "Answered" : "Action needed"} · {message.from}</p>
  <Markdown text={message.body} />
  {#if !answered}
    <div class="mt-3 flex flex-wrap gap-2">
      {#each message.meta.options ?? [] as option (option)}
        <button class="rounded-full border border-line bg-surface px-3 py-1 text-[13px] hover:border-ink" disabled={sending} onclick={() => answer(option)}>{option}</button>
      {/each}
    </div>
    {#if message.meta.freeText !== false}
      <form class="mt-2 flex gap-2" onsubmit={(e) => { e.preventDefault(); void answer(text); }}>
        <input class="min-w-0 flex-1 border border-line bg-surface px-2 py-1.5" placeholder="Answer in your own words" bind:value={text} />
        <button class="bg-ink px-3 text-bg disabled:opacity-40" disabled={sending || !text.trim()}>Answer</button>
      </form>
    {/if}
  {/if}
</div>
