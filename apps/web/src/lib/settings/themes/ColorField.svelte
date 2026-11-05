<script lang="ts">
  import { theme } from "../../theme.svelte";
  import { fromHex, isColor, resolveColor, toCss, toHex } from "../../theme/color";
  import { INPUT } from "../controls";

  /**
   * A colour: the swatch opens the browser's picker, the slider sets how solid it is, the text takes any CSS colour.
   * With no value of its own it shows what the page has now (`inherited`).
   */
  let { value, inherited, label, onchange }: { value: string | undefined; inherited: () => string; label: string; onchange: (next: string | undefined) => void } = $props();

  let typing = $state<string | null>(null);
  const PERCENT = 100;

  const shown = $derived.by(() => {
    // Another row's change can move what this one inherits.
    void theme.custom;
    return resolveColor(value ?? inherited());
  });
  const invalid = $derived(typing !== null && typing !== "" && !isColor(typing));

  function typed(text: string) {
    typing = text;
    if (!text) onchange(undefined);
    else if (isColor(text)) onchange(text);
  }
</script>

<span class="flex min-w-0 flex-1 items-center gap-1.5">
  <span class="color-chip relative size-8 shrink-0 overflow-hidden rounded-sm border border-line">
    <span class="absolute inset-0" style:background={toCss(shown)}></span>
    <input type="color" class="absolute inset-0 size-full cursor-pointer opacity-0" aria-label={label} value={toHex(shown)} oninput={(event) => onchange(toCss(fromHex(event.currentTarget.value, shown.a || 1)))} />
  </span>
  <input
    class="{INPUT} min-w-0 flex-1 font-mono {invalid ? 'border-hot focus:border-hot' : ''}"
    aria-label="{label} value"
    aria-invalid={invalid}
    spellcheck="false"
    placeholder={toCss(shown)}
    value={typing ?? value ?? ""}
    oninput={(event) => typed(event.currentTarget.value)}
    onblur={() => (typing = null)}
  />
  <input type="range" class="opacity-range w-12 shrink-0" min="0" max={PERCENT} aria-label="{label} opacity" value={Math.round(shown.a * PERCENT)} oninput={(event) => onchange(toCss({ ...shown, a: Number(event.currentTarget.value) / PERCENT }))} />
</span>
