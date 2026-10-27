<script lang="ts">
  import Icon from "../ui/Icon.svelte";

  /** The pills an answer offers; a bubble for an answer in words, a bin to drop the question. */
  let {
    options,
    freeText,
    onreply,
    onwords,
    ondrop,
  }: { options: readonly string[]; freeText: boolean; onreply: (text: string) => void; onwords?: () => void; ondrop?: () => void } = $props();
</script>

<div class="q-options">
  {#each options as option (option)}
    <button class="opt" onclick={() => onreply(option)}>{option}</button>
  {/each}
  {#if freeText && onwords}<button class="opt icon-only" title={options.length ? "answer in words" : "answer"} aria-label="Answer in words" onclick={onwords}><Icon name="message" size={15} /></button>{/if}
  {#if ondrop}<button class="opt icon-only faint" title="drop this question" aria-label="Drop" onclick={ondrop}><Icon name="trash" size={15} /></button>{/if}
</div>
