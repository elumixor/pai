<script lang="ts">
  import type { Snippet } from "svelte";

  /** A row of a popup menu (app.css `.menu-item`); `active` is the row under the keyboard. */
  let { onclick, children, danger = false, active = false }: { onclick: () => void; children: Snippet; danger?: boolean; active?: boolean } = $props();
</script>

<button class="menu-item {danger ? 'text-hot' : '[&>svg]:text-ink-45'}" data-active={active ? "true" : undefined} {onclick}>{@render children()}</button>
