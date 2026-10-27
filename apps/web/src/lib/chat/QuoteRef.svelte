<script lang="ts">
  import Icon from "../ui/Icon.svelte";
  import type { ReplyQuote } from "./model";

  /** The reply a message carries, as a small bar: who, the excerpt; a click jumps to what it answers. */
  let { quote, onjump }: { quote: ReplyQuote; onjump: (quote: ReplyQuote) => void } = $props();
</script>

<button class="quote-ref" type="button" onclick={(e) => (e.stopPropagation(), onjump(quote))}><Icon name="reply" size={10} /><b>{quote.from}</b><span class="ellipsis">{quote.excerpt}</span></button>
