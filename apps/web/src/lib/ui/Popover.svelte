<script lang="ts" module>
  /** The popovers open now, the last opened last. */
  const openStack: object[] = [];
</script>

<script lang="ts">
  import { POPUP, portal } from "./popup";
  import type { Snippet } from "svelte";
  import { cubicOut } from "svelte/easing";
  import { fade, scale } from "svelte/transition";

  /**
   * A floating panel anchored to its trigger; closes on Escape or a click outside. Fixed to the viewport, so a
   * scrolling sidebar or table never clips it, and it flips above the trigger when there is no room below.
   */
  let {
    open = $bindable(false),
    trigger,
    children,
    align = "start",
    width = "w-64",
    block = false,
  }: {
    open?: boolean;
    trigger: Snippet<[{ toggle: () => void }]>;
    children: Snippet<[{ close: () => void }]>;
    align?: "start" | "end";
    width?: string;
    /** The trigger fills its container's width, as a table header or a property value does. */
    block?: boolean;
  } = $props();

  const GAP = 4;
  const MARGIN = 8;
  let root = $state<HTMLDivElement>();
  let panel = $state<HTMLDivElement>();
  let position = $state({ top: 0, left: 0 });
  const close = () => (open = false);
  const toggle = () => (open = !open);

  function place() {
    if (!root || !panel) return;
    const anchor = root.getBoundingClientRect();
    const { offsetWidth: w, offsetHeight: h } = panel;
    const left = Math.min(Math.max(MARGIN, align === "end" ? anchor.right - w : anchor.left), innerWidth - w - MARGIN);
    const below = anchor.bottom + GAP;
    const top = below + h > innerHeight - MARGIN && anchor.top - h - GAP > MARGIN ? anchor.top - h - GAP : below;
    position = { top, left };
  }

  // A search field in the panel takes focus as it opens.
  $effect(() => {
    if (open) panel?.querySelector<HTMLElement>("input:not([type=hidden]), textarea")?.focus({ preventScroll: true });
  });

  $effect(() => {
    if (!open || !panel) return;
    place();
    const observer = new ResizeObserver(place);
    observer.observe(panel);
    addEventListener("scroll", place, true);
    addEventListener("resize", place);
    return () => {
      observer.disconnect();
      removeEventListener("scroll", place, true);
      removeEventListener("resize", place);
    };
  });

  function onWindowClick(event: MouseEvent) {
    const target = event.target as Element;
    // A popover opened from inside this one sits after it in the body.
    const other = target.closest?.("[data-popover]");
    if (other && panel && panel.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING) return;
    if (open && root && !root.contains(target) && !panel?.contains(target)) close();
  }
  // Escape closes only the popover opened last: one opened from inside another closes first.
  const me = {};
  $effect(() => {
    if (!open) return;
    openStack.push(me);
    return () => {
      openStack.splice(openStack.indexOf(me), 1);
    };
  });

  function onKey(event: KeyboardEvent) {
    if (!open || event.key !== "Escape" || event.defaultPrevented || openStack.at(-1) !== me) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  }
</script>

<svelte:window onmousedown={onWindowClick} onkeydown={onKey} />

<div class="relative max-w-full {block ? 'block w-full' : 'inline-block'}" bind:this={root}>
  {@render trigger({ toggle })}
  {#if open}
    <div
      bind:this={panel}
      use:portal
      data-popover
      in:scale={{ start: 0.96, duration: 140, easing: cubicOut }}
      out:fade={{ duration: 90 }}
      class="fixed z-50 max-h-[min(28rem,calc(100dvh-1rem))] max-w-[calc(100vw-1rem)] overflow-y-auto {POPUP} text-left font-normal {width}"
      style="top: {position.top}px; left: {position.left}px"
    >
      {@render children({ close })}
    </div>
  {/if}
</div>
