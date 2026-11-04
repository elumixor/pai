<script lang="ts" generics="T extends string | number">
  /** One choice out of a few, all in view. */
  let { options, value, label, onchange }: { options: readonly { readonly value: T; readonly label: string }[]; value: T | undefined; label: string; onchange: (next: T) => void } = $props();
</script>

<div class="inline-flex max-w-full flex-wrap gap-0.5 rounded-sm bg-ink-5 p-0.5" role="radiogroup" aria-label={label}>
  {#each options as option (option.value)}
    {@const on = option.value === value}
    <button type="button" role="radio" aria-checked={on} class="h-7 rounded-xs px-2.5 text-[13px] transition-colors {on ? 'bg-surface font-medium text-ink' : 'text-ink-45 hover:text-ink'}" onclick={() => onchange(option.value)}>{option.label}</button>
  {/each}
</div>
