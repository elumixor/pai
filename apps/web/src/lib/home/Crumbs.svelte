<script lang="ts" module>
  export interface Crumb {
    /** What makes it the same crumb across changes: the row it stands for, not its wording. */
    readonly key: string;
    readonly label: string;
    readonly title?: string;
    readonly open?: () => void;
  }
</script>

<script lang="ts">
  import type { Snippet } from "svelte";
  import { flip } from "svelte/animate";
  import { fly } from "svelte/transition";

  /**
   * The way here, level with the nav, centred over the chat: General › parent › … › here. One bar for every page, so a
   * change is a difference, not a redraw: the crumbs that stay slide to where they now sit, the new ones come in.
   * Under them, the open chat hangs its find bar; the band publishes its height, which the chat's fade reads.
   */
  let { crumbs, tail }: { crumbs: readonly Crumb[]; tail?: Snippet } = $props();
  let band = $state<HTMLElement>();
  const BASE = 27;
  const motion = () => (matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 320);

  $effect(() => {
    if (!band) return;
    const node = band;
    const publish = () => {
      const height = Math.round(node.getBoundingClientRect().height) || BASE;
      document.documentElement.style.setProperty("--band-h", `${height}px`);
      document.documentElement.style.setProperty("--band-extra", `${Math.max(0, height - BASE)}px`);
    };
    const observer = new ResizeObserver(publish);
    observer.observe(node);
    publish();
    return () => observer.disconnect();
  });
</script>

<nav class="crumbs home-crumbs" aria-label="Where you are" bind:this={band}>
  <div class="crumb-line">
    {#each crumbs as crumb, i (crumb.key)}
      {@const here = i === crumbs.length - 1}
      <span class="crumb-item" animate:flip={{ duration: motion() }} in:fly={{ x: 10, duration: motion() }}>
        <span class="crumb-sep" aria-hidden="true">›</span>
        <button class="crumb" class:here type="button" title={crumb.title} disabled={here || !crumb.open} onclick={() => !here && crumb.open?.()}>{crumb.label}</button>
      </span>
    {/each}
    <span class="crumb-tail">{@render tail?.()}</span>
  </div>
  <div class="crumb-under"></div>
</nav>
