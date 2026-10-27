<script lang="ts">
  import { clock } from "../format";
  import { kindIcon } from "../kinds";
  import { md } from "../markdown";
  import Icon from "../ui/Icon.svelte";
  import AnswerButtons from "./AnswerButtons.svelte";
  import type { RowContext } from "./context";
  import type { LiveQuestion } from "./model";

  /** A question the session asked: one block per question, the answered ones ticked, the next one with its buttons. */
  let { q, ctx, attach = () => undefined }: { q: LiveQuestion; ctx: RowContext; attach?: (node: HTMLElement) => (() => void) | undefined } = $props();
  const index = $derived(q.questions.findIndex((_, i) => !q.answers[i]));
  const open = $derived(index >= 0);

  async function reply(i: number, text: string) {
    if (await ctx.answerQuestion(q.session, text)) q.answers[i] = text;
  }
</script>

<div {@attach attach} class="row question tint-warn" class:open class:answered={!open} data-question={q.id} data-at={q.at} data-key={q.key} data-testid="question">
  {#each q.questions as question, i (i)}
    <div class="q-block">
      <div class="q-meta"><Icon name={kindIcon("approval")} size={10} /><b>{open ? "Action needed" : "Decision made"}</b>{#if question.header}<span>· {question.header}</span>{/if}</div>
      <div class="q-body" {@attach md(question.question)}></div>
      {#if q.answers[i]}
        <div class="q-foot"><div class="q-answer"><Icon name="check" size={10} /><span>{q.answers[i]}</span></div>{#if i === 0}<time>{clock(q.at)}</time>{/if}</div>
      {:else if i === index}
        <div class="q-foot">
          <AnswerButtons options={question.options.map((o) => o.label)} freeText onreply={(text) => void reply(i, text)} onwords={() => ctx.pinAnswer(question.question, (text) => reply(i, text))} />
          {#if i === 0}<time>{clock(q.at)}</time>{/if}
        </div>
      {:else if i === 0}
        <div class="q-foot"><span></span><time>{clock(q.at)}</time></div>
      {/if}
    </div>
  {/each}
</div>
