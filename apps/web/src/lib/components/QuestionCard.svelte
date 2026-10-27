<script lang="ts">
  import { api } from "$lib/api";
  import type { PendingQuestion } from "$lib/stores/conversation.svelte";
  import { notices } from "$lib/stores/notices.svelte";

  /** A session's `AskUserQuestion`, answered in place; several questions are answered one line each. */
  let { session, pending }: { session: string; pending: PendingQuestion } = $props();
  let picked = $state<Record<number, string>>({});
  let busy = $state(false);

  const complete = $derived(pending.questions.every((_, i) => picked[i]));

  async function submit() {
    busy = true;
    try {
      const text = pending.questions.map((q, i) => (pending.questions.length > 1 ? `${q.header}: ${picked[i]}` : picked[i])).join("\n");
      await api.answerQuestion(session, text);
    } catch (error) {
      notices.error(error);
    } finally {
      busy = false;
    }
  }
</script>

<div class="space-y-4 border border-accent/40 bg-accent-soft/40 px-4 py-3" data-testid="question">
  {#each pending.questions as question, index (index)}
    <div>
      <p class="mb-2 font-medium">{question.question}</p>
      <div class="flex flex-wrap gap-2">
        {#each question.options as option (option.label)}
          <button
            class="rounded-full border px-3 py-1 text-[13px] {picked[index] === option.label ? 'border-ink bg-ink text-bg' : 'border-line bg-surface hover:border-ink'}"
            title={option.description}
            onclick={() => (picked = { ...picked, [index]: option.label })}>{option.label}</button
          >
        {/each}
      </div>
      <input class="mt-2 w-full border border-line bg-surface px-2 py-1.5 text-[13px]" placeholder="Or say something else" oninput={(e) => (picked = { ...picked, [index]: e.currentTarget.value })} />
    </div>
  {/each}
  <button class="bg-ink px-4 py-1.5 text-bg disabled:opacity-40" disabled={busy || !complete} onclick={submit}>Answer</button>
</div>
