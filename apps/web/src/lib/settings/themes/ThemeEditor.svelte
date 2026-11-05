<script lang="ts">
  import { ChevronRight, RotateCcw } from "lucide-svelte";
  import { type ElementId, ELEMENTS, FONTS, type TokenId, TOKENS } from "../../theme/catalog";
  import { firstFamily, rootVariable } from "../../theme/current";
  import { type CustomTheme, fontStack } from "../../theme/custom";
  import type { ThemeEdit } from "../../theme/edit.svelte";
  import { BLOCK_TITLE, BUTTON } from "../controls";
  import ColorField from "./ColorField.svelte";
  import ElementControls from "./ElementControls.svelte";
  import FontField from "./FontField.svelte";
  import SizeField from "./SizeField.svelte";
  import ThemePreview from "./ThemePreview.svelte";

  /**
   * The theme being edited is the one on, so every change shows at once in the sample and in the app around it. Elements
   * come first: that is what one comes here to change; tokens repaint everything at once.
   */
  let { edit, current }: { edit: ThemeEdit; current: CustomTheme } = $props();

  const groupsOf = <T extends { readonly group: string }>(all: readonly T[]) => [...new Set(all.map((entry) => entry.group))].map((group) => ({ group, entries: all.filter((entry) => entry.group === group) }));
  const ELEMENT_GROUPS = groupsOf(ELEMENTS);
  const TOKEN_GROUPS = groupsOf(TOKENS);

  let open = $state<ElementId | null>(null);
  let list = $state<HTMLElement>();
  const changed = $derived(Object.keys(current.tokens).length + Object.keys(current.elements).length > 0);

  const isTextField = (target: EventTarget | null) => target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && target.type !== "range" && target.type !== "color");

  function onkeydown(event: KeyboardEvent) {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z" || isTextField(event.target)) return;
    event.preventDefault();
    if (event.shiftKey) edit.redo();
    else edit.undo();
  }

  function pick(id: ElementId) {
    open = id;
    queueMicrotask(() => list?.querySelector(`[data-row="${id}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  }

  const setToken = (id: TokenId) => (next: string | number | undefined) => edit.setToken(id, next === undefined ? undefined : String(next));
</script>

<svelte:window {onkeydown} />

<datalist id="theme-fonts">
  {#each FONTS as font (font.name)}<option value={font.name}></option>{/each}
</datalist>

<div bind:this={list} class="w-96 shrink-0 space-y-5 overflow-y-auto border-r border-line px-4 py-4 max-md:order-2 max-md:min-h-0 max-md:w-full max-md:flex-1 max-md:border-t max-md:border-r-0">
  {#each ELEMENT_GROUPS as { group, entries } (group)}
    <section>
      <p class={BLOCK_TITLE}>{group}</p>
      {#each entries as entry (entry.id)}
        {@const style = current.elements[entry.id] ?? {}}
        {@const expanded = open === entry.id}
        <div class="border-b border-line last:border-b-0" data-row={entry.id}>
          <button type="button" class="flex min-h-9 w-full items-center gap-2 rounded-xs text-left text-[13px] transition-colors hover:bg-ink-5" aria-expanded={expanded} onclick={() => (open = expanded ? null : entry.id)}>
            <ChevronRight size={14} class="text-ink-30 transition-transform {expanded ? 'rotate-90' : ''}" />
            <span class="min-w-0 flex-1 truncate" style:color={style.color} style:font-family={fontStack(style.font)} style:font-weight={style.weight} style:font-style={style.italic === undefined ? undefined : style.italic ? "italic" : "normal"} style:text-decoration={style.underline === undefined ? undefined : style.underline ? "underline" : "none"}>{entry.label}</span>
            {#if Object.keys(style).length}<span class="mr-1 size-1.5 shrink-0 rounded-full bg-accent" aria-label="Changed"></span>{/if}
          </button>
          {#if expanded}<ElementControls {edit} id={entry.id} {style} />{/if}
        </div>
      {/each}
    </section>
  {/each}

  {#each TOKEN_GROUPS as { group, entries } (group)}
    <section>
      <p class={BLOCK_TITLE}>{group}</p>
      <div class="space-y-1.5">
        {#each entries as token (token.id)}
          {@const value = current.tokens[token.id]}
          <div class="flex min-h-8 items-center gap-2">
            <span class="w-24 shrink-0 truncate text-[12px] text-ink-45">{token.label}</span>
            {#if token.kind === "color"}
              <ColorField {value} inherited={() => `var(${token.vars[0]})`} label={token.label} onchange={setToken(token.id)} />
            {:else if token.kind === "font"}
              <FontField {value} placeholder={firstFamily(rootVariable(token.vars[0]))} label={token.label} onchange={setToken(token.id)} />
            {:else}
              <SizeField value={value === undefined ? undefined : Number(value)} placeholder={String(Number.parseFloat(rootVariable(token.vars[0])))} label={token.label} onchange={setToken(token.id)} />
            {/if}
            <button type="button" class="grid size-6 shrink-0 place-items-center rounded-xs text-ink-30 transition-colors hover:bg-ink-5 hover:text-ink {value === undefined ? 'invisible' : ''}" aria-label="Reset {token.label}" onclick={() => edit.setToken(token.id, undefined)}><RotateCcw size={12} /></button>
          </div>
        {/each}
      </div>
    </section>
  {/each}

  <button type="button" class={BUTTON} disabled={!changed} onclick={() => edit.resetAll()}><RotateCcw size={14} />Reset all</button>
</div>

<div class="flex min-w-0 flex-1 overflow-y-auto max-md:order-1 max-md:h-64 max-md:flex-none">
  <ThemePreview {open} onpick={pick} />
</div>
