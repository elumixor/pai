<script lang="ts">
  import Icon from "./Icon.svelte";
  import { menus } from "./menu-state.svelte";

  let contextBox = $state<HTMLDivElement>();
  let dropdownBox = $state<HTMLDivElement>();
  let contextOpen = $state(false);

  // The context menu grows out of the corner nearest the pointer, inside the window.
  $effect(() => {
    const open = menus.context;
    const box = contextBox;
    contextOpen = false;
    if (!open || !box) return;
    const left = open.x + box.offsetWidth > window.innerWidth - 8 ? open.x - box.offsetWidth : open.x;
    const top = open.y + box.offsetHeight > window.innerHeight - 8 ? open.y - box.offsetHeight : open.y;
    box.style.left = `${Math.max(8, left)}px`;
    box.style.top = `${Math.max(8, top)}px`;
    box.style.transformOrigin = `${left < open.x ? "right" : "left"} ${top < open.y ? "bottom" : "top"}`;
    requestAnimationFrame(() => (contextOpen = true));
    box.querySelector<HTMLButtonElement>(".ctx-row")?.focus({ preventScroll: true });
  });

  // The small menu sits above its button, or below it when there is no room.
  $effect(() => {
    const open = menus.dropdown;
    const box = dropdownBox;
    if (!open || !box) return;
    const at = open.anchor.getBoundingClientRect();
    box.style.left = `${Math.min(at.left, window.innerWidth - box.offsetWidth - 8)}px`;
    box.style.top = `${at.top - box.offsetHeight - 6 < 0 ? at.bottom + 6 : at.top - box.offsetHeight - 6}px`;
  });

  function outside(event: PointerEvent) {
    const target = event.target as Node;
    if (menus.context && contextBox && !contextBox.contains(target)) menus.context = null;
    if (menus.dropdown && dropdownBox && !dropdownBox.contains(target) && !menus.dropdown.anchor.contains(target)) menus.dropdown = null;
  }

  function keys(event: KeyboardEvent) {
    if (!menus.context && !menus.dropdown) return;
    if (event.key === "Escape") return menus.close();
    if (!menus.context || !contextBox || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
    event.preventDefault();
    const rows = [...contextBox.querySelectorAll<HTMLButtonElement>(".ctx-row")];
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    rows[(at + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length]?.focus();
  }
</script>

<svelte:document onpointerdown={outside} onkeydown={keys} />
<svelte:window onblur={() => (menus.context = null)} onwheel={() => (menus.context = null)} />

{#if menus.context}
  <div class="ctx-menu" class:open={contextOpen} role="menu" bind:this={contextBox}>
    {#each menus.context.actions as action (action.label)}
      <button class="ctx-row" type="button" role="menuitem" onclick={() => (menus.close(), action.run())}><Icon name={action.icon} size={14} /><span>{action.label}</span></button>
    {/each}
  </div>
{/if}

{#if menus.dropdown}
  <div class="menu" role="menu" bind:this={dropdownBox}>
    {#each menus.dropdown.rows as row (row.label)}
      <button class="menu-row" class:on={row.on} role="menuitem" onclick={() => (menus.close(), row.pick())}><span>{row.label}</span>{#if row.hint}<span class="dim">{row.hint}</span>{/if}</button>
    {/each}
  </div>
{/if}
