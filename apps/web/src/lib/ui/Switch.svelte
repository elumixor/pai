<script lang="ts">
  let { checked, label, disabled = false, onchange }: { checked: boolean; label: string; disabled?: boolean; onchange: (next: boolean) => void } = $props();
</script>

<button
  type="button"
  role="switch"
  aria-checked={checked}
  aria-label={label}
  {disabled}
  class="relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50 {checked ? 'bg-accent' : 'bg-ink-20'}"
  onclick={() => onchange(!checked)}
>
  <span class="absolute top-0.5 left-0.5 size-4 rounded-full bg-surface transition-transform {checked ? 'translate-x-4' : ''}"></span>
</button>
