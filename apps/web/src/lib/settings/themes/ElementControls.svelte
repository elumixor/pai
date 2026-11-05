<script lang="ts">
  import { Italic, Underline } from "lucide-svelte";
  import { type ElementId, type ElementProp, elementDef } from "../../theme/catalog";
  import { firstFamily, sampleStyle } from "../../theme/current";
  import type { ElementStyle } from "../../theme/custom";
  import type { ThemeEdit } from "../../theme/edit.svelte";
  import Segmented from "../../ui/Segmented.svelte";
  import { BUTTON } from "../controls";
  import ColorField from "./ColorField.svelte";
  import FontField from "./FontField.svelte";
  import SizeField from "./SizeField.svelte";

  /** The properties one element offers, opened in place under its row. */
  let { edit, id, style }: { edit: ThemeEdit; id: ElementId; style: ElementStyle } = $props();

  const WEIGHTS = [
    { value: 400, label: "Regular" },
    { value: 500, label: "Medium" },
    { value: 700, label: "Bold" },
  ] as const;
  const def = $derived(elementDef(id));
  const offers = (prop: ElementProp) => def.offers.includes(prop);

  /** An element drawn through a variable is read from it: its sample's own box may not be what paints it. */
  function inherited(prop: "color" | "background") {
    const variable = def.vars?.[prop];
    if (variable) return `var(${variable})`;
    const sample = sampleStyle(id);
    return (prop === "color" ? sample?.color : sample?.backgroundColor) ?? "transparent";
  }

  const toggle = (on: boolean) => `grid size-7 place-items-center rounded-xs transition-colors ${on ? "bg-ink-10 text-ink" : "text-ink-45 hover:bg-ink-5 hover:text-ink"}`;
  const italic = $derived(style.italic ?? def.looks?.italic ?? false);
  const underline = $derived(style.underline ?? def.looks?.underline ?? false);
</script>

{#snippet row(label: string, control: import("svelte").Snippet)}
  <div class="flex min-h-7 items-center gap-2">
    <span class="w-20 shrink-0 text-[12px] text-ink-45">{label}</span>
    {@render control()}
  </div>
{/snippet}

<div class="space-y-1.5 pt-1 pb-3">
  {#if offers("color")}
    {#snippet control()}<ColorField value={style.color} inherited={() => inherited("color")} label="{def.label} text colour" onchange={(next) => edit.setElement(id, "color", next)} />{/snippet}
    {@render row("Text", control)}
  {/if}
  {#if offers("background")}
    {#snippet control()}<ColorField value={style.background} inherited={() => inherited("background")} label="{def.label} background" onchange={(next) => edit.setElement(id, "background", next)} />{/snippet}
    {@render row("Background", control)}
  {/if}
  {#if offers("font")}
    {#snippet control()}<FontField value={style.font} placeholder={firstFamily(sampleStyle(id)?.fontFamily ?? "")} label="{def.label} font" onchange={(next) => edit.setElement(id, "font", next)} />{/snippet}
    {@render row("Font", control)}
  {/if}
  {#if offers("size")}
    {#snippet control()}<SizeField value={style.size} placeholder={String(Number.parseFloat(sampleStyle(id)?.fontSize ?? ""))} label="{def.label} size" onchange={(next) => edit.setElement(id, "size", next)} />{/snippet}
    {@render row("Size", control)}
  {/if}
  {#if offers("weight")}
    {#snippet control()}<Segmented options={WEIGHTS} value={style.weight ?? def.looks?.weight ?? 400} label="{def.label} weight" onchange={(next) => edit.setElement(id, "weight", next)} />{/snippet}
    {@render row("Weight", control)}
  {/if}
  {#if offers("italic") || offers("underline")}
    {#snippet control()}
      <span class="flex gap-1">
        {#if offers("italic")}<button type="button" class={toggle(italic)} aria-pressed={italic} aria-label="Italic" onclick={() => edit.setElement(id, "italic", !italic)}><Italic size={14} /></button>{/if}
        {#if offers("underline")}<button type="button" class={toggle(underline)} aria-pressed={underline} aria-label="Underline" onclick={() => edit.setElement(id, "underline", !underline)}><Underline size={14} /></button>{/if}
      </span>
    {/snippet}
    {@render row("Style", control)}
  {/if}
  {#if Object.keys(style).length}<button type="button" class="{BUTTON} h-7 text-[12px]" onclick={() => edit.resetElement(id)}>Reset {def.label.toLowerCase()}</button>{/if}
</div>
