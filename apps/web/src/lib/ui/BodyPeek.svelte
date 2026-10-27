<script lang="ts">
  import { md } from "../markdown";
  import Icon from "./Icon.svelte";
  import { bodyPeek } from "./peek.svelte";

  let card = $state<HTMLDivElement>();

  // Under the trigger, or over it when the window has no room below.
  $effect(() => {
    const shown = bodyPeek.shown;
    if (!shown || !card) return;
    const at = shown.anchor;
    card.style.left = `${Math.min(Math.max(8, at.left), window.innerWidth - card.offsetWidth - 8)}px`;
    const below = at.bottom + 8;
    card.style.top = `${below + card.offsetHeight > window.innerHeight - 8 ? Math.max(8, at.top - card.offsetHeight - 8) : below}px`;
  });
</script>

{#if bodyPeek.shown}
  {@const c = bodyPeek.shown.content}
  <div class="peek body-peek" role="tooltip" bind:this={card} onpointerenter={() => bodyPeek.hold()} onpointerleave={() => bodyPeek.closeSoon()}>
    {#if c.title || c.glyph}
      <div class="peek-line">
        {#if c.glyph === "spinner"}<span class="spinner"></span>{:else if c.glyph}<Icon name={c.glyph} size={12} />{/if}
        {#if c.title}<b>{c.title}</b>{/if}
        {#if c.dim}<span class="dim">{c.dim}</span>{/if}
      </div>
    {/if}
    {#if c.body?.trim()}<div class="peek-body" {@attach md(c.body)}></div>{/if}
    {#if c.foot}<div class="peek-foot">{c.foot}</div>{/if}
  </div>
{/if}
