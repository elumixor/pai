<script lang="ts">
  import type { Snippet } from "svelte";
  import { cubicOut } from "svelte/easing";
  import { fade } from "svelte/transition";

  /**
   * Content with a panel sliding in from the right. Where both fit, the panel takes its width from the content;
   * where they do not, it lies over the content, which keeps its width and darkens.
   */
  let { open, onclose, panel, children }: { open: boolean; onclose: () => void; panel: Snippet; children: Snippet } = $props();

  const PANEL_WIDTH = 440;
  /** The chat's column stays readable down to here, its side padding included. */
  const MIN_CONTENT_WIDTH = 620;
  /** The darkened strip left beside a panel on a phone: what shows it lies over something, and closes it. */
  const OVERLAY_GUTTER = 40;
  const MOTION_MS = 240;

  let width = $state(0);
  const docked = $derived(width >= PANEL_WIDTH + MIN_CONTENT_WIDTH);
  const panelWidth = $derived(Math.min(PANEL_WIDTH, width - OVERLAY_GUTTER));
  const motionMs = () => (matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : MOTION_MS);

  /** Docked the width grows, pushing the content; the body keeps its width and is uncovered from its left edge on. */
  const slide = (_node: Element) => ({
    duration: motionMs(),
    easing: cubicOut,
    css: (t: number, u: number) => (docked ? `width: ${t * panelWidth}px` : `transform: translateX(${u * 100}%)`),
  });

  function keydown(event: KeyboardEvent) {
    if (!open || event.key !== "Escape" || event.defaultPrevented || document.querySelector("dialog[open]")) return;
    if ((event.target as Element).closest("input, textarea, select, [contenteditable]")) return;
    onclose();
  }
</script>

<svelte:window onkeydown={keydown} />

<!-- Not clipped here: the panel's edge reaches up through the bar. The page clips what lies past the screen's right. -->
<div class="relative flex min-h-0 flex-1" bind:clientWidth={width}>
  <div class="isolate flex min-w-0 flex-1 flex-col overflow-clip">{@render children()}</div>
  {#if open && !docked}
    <div class="absolute inset-0 z-10 bg-[var(--backdrop)]" role="presentation" transition:fade={{ duration: motionMs() }} onclick={onclose}></div>
  {/if}
  {#if open}
    <aside class="z-20 shrink-0 bg-page {docked ? 'relative' : 'absolute inset-y-0 right-0 shadow-[var(--soft-shadow)]'}" style:width="{panelWidth}px" transition:slide>
      <div class="pointer-events-none absolute -top-11 bottom-0 left-0 border-l border-line" aria-hidden="true"></div>
      <div class="h-full bg-page" style:width="{panelWidth}px">{@render panel()}</div>
    </aside>
  {/if}
</div>
