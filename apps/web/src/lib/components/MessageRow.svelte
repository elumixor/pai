<script lang="ts">
  import { ChevronRight } from "lucide-svelte";
  import { attachmentUrl } from "$lib/api";
  import type { LogMessage } from "$lib/types";
  import AskCard from "./AskCard.svelte";
  import DraftCard from "./DraftCard.svelte";
  import Markdown from "./Markdown.svelte";

  /**
   * One row of the message log, by what it is: the user's bubble, a reply, an ask or a draft card, or a one-line
   * event, delegation, report or notice that opens to its full text.
   */
  let { message, answered }: { message: LogMessage; answered: boolean } = $props();
  let open = $state(false);

  const ONE_LINERS = new Set(["event", "notice", "report", "delegate", "request", "response"]);
  const time = $derived(new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
  const fromUser = $derived(message.from === "user");
  const label = $derived(
    message.kind === "delegate" ? `Delegated to ${message.to}` : message.kind === "report" ? `Report from ${message.from}` : (message.meta.event ?? message.kind),
  );
</script>

{#if message.meta.draft}
  <DraftCard {message} />
{:else if message.kind === "ask"}
  <AskCard {message} {answered} />
{:else if ONE_LINERS.has(message.kind)}
  <div class="text-[13px]" data-kind={message.kind}>
    <button class="flex w-full items-center gap-2 text-left text-muted hover:text-ink" onclick={() => (open = !open)}>
      <span class="font-mono text-[11px] text-faint">{time}</span>
      <span class="font-medium">{label}</span>
      <span class="min-w-0 flex-1 truncate">{message.meta.headline ?? message.meta.tldr ?? message.body.split("\n")[0]}</span>
      <ChevronRight size={12} class="shrink-0 transition-transform {open ? 'rotate-90' : ''}" />
    </button>
    {#if open}<div class="mt-1 border-l border-line pl-3"><Markdown text={message.body} /></div>{/if}
  </div>
{:else if fromUser}
  <div class="flex justify-end" data-kind="user">
    <div class="max-w-[85%] rounded-2xl rounded-br-sm bg-ink/[0.06] px-4 py-2">
      {#if message.meta.quote}<p class="mb-1 border-l-2 border-accent pl-2 text-[12px] text-muted">{message.meta.quote.excerpt}</p>{/if}
      <p class="whitespace-pre-wrap">{message.body}</p>
      {#each message.meta.images ?? [] as image (image)}<img src={attachmentUrl(image)} alt="" class="mt-2 max-h-64 rounded" />{/each}
    </div>
  </div>
{:else}
  <div data-kind="reply">
    <Markdown text={message.body} />
    {#each message.meta.images ?? [] as image (image)}<img src={attachmentUrl(image)} alt="" class="mt-2 max-h-80" />{/each}
  </div>
{/if}
