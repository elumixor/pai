<script lang="ts">
  import { SIZE_RANGE } from "../../theme/catalog";
  import { INPUT } from "../controls";

  /** A size in pixels. */
  let { value, placeholder, label, onchange }: { value: number | undefined; placeholder: string; label: string; onchange: (next: number | undefined) => void } = $props();
</script>

<span class="flex min-w-0 flex-1 items-center gap-1.5">
  <input class="{INPUT} max-w-20" type="number" min={SIZE_RANGE.min} max={SIZE_RANGE.max} aria-label={label} {placeholder} value={value ?? ""} oninput={(event) => onchange(event.currentTarget.value ? Number(event.currentTarget.value) : undefined)} />
  <span class="text-[12px] text-ink-30">px</span>
</span>
