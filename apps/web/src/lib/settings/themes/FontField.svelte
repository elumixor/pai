<script lang="ts">
  import { INPUT } from "../controls";

  /** A font by name: one from the list `ThemeEditor` provides, or any other installed here. */
  let { value, placeholder, label, onchange }: { value: string | undefined; placeholder: string; label: string; onchange: (next: string | undefined) => void } = $props();
</script>

<input class="{INPUT} h-7 min-w-0 flex-1 px-1.5 text-[12px]" list="theme-fonts" aria-label={label} {placeholder} value={value ?? ""} oninput={(event) => onchange(event.currentTarget.value.trim() || undefined)} />
