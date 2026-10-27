<script lang="ts">
  import { tick } from "svelte";
  import { Conversation } from "$lib/stores/conversation.svelte";
  import Composer from "./Composer.svelte";
  import LiveTurn from "./LiveTurn.svelte";
  import MessageRow from "./MessageRow.svelte";
  import QuestionCard from "./QuestionCard.svelte";

  let { agent, title }: { agent: string; title: string } = $props();

  const conversation = $derived(new Conversation(agent));
  let scroller = $state<HTMLDivElement>();
  let pinned = true;
  /** Asks the log already has an answer for, so their buttons go. */
  const answered = $derived(new Set(conversation.messages.filter((m) => m.kind === "answer" && m.meta.askId).map((m) => m.meta.askId)));

  $effect(() => {
    const c = conversation;
    void c.open().then(() => scrollToEnd());
    return () => c.close();
  });

  $effect(() => {
    void conversation.messages.length;
    void conversation.streaming;
    if (pinned) void scrollToEnd();
  });

  async function scrollToEnd() {
    await tick();
    scroller?.scrollTo({ top: scroller.scrollHeight });
  }

  async function onscroll() {
    if (!scroller) return;
    pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
    if (scroller.scrollTop < 120 && conversation.hasOlder) {
      const before = scroller.scrollHeight;
      await conversation.loadOlder();
      await tick();
      scroller.scrollTop += scroller.scrollHeight - before;
    }
  }
</script>

<div class="flex h-full flex-col">
  <header class="flex h-12 shrink-0 items-center border-b border-line px-5">
    <h1 class="font-display text-lg font-semibold">{title}</h1>
  </header>
  <div class="min-h-0 flex-1 overflow-y-auto" bind:this={scroller} {onscroll}>
    <div class="mx-auto max-w-[760px] space-y-5 px-5 py-6" data-testid="messages">
      {#if !conversation.loaded}
        {#each [1, 2, 3] as row (row)}<div class="h-12 animate-pulse bg-sunken"></div>{/each}
      {:else if !conversation.messages.length}
        <p class="py-16 text-center text-muted">Nothing here yet. Say what you need.</p>
      {/if}
      {#each conversation.messages as message (message.id)}
        <MessageRow {message} answered={answered.has(message.meta.askId)} />
      {/each}
      <LiveTurn {conversation} />
      {#if conversation.question && conversation.sessionId}
        <QuestionCard session={conversation.sessionId} pending={conversation.question} />
      {/if}
    </div>
  </div>
  <div class="mx-auto w-full max-w-[760px] px-5 pb-5">
    <Composer draftKey={agent} onsend={(text, images) => conversation.send(text, images)} />
  </div>
</div>
