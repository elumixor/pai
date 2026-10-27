<script lang="ts">
  import { ICONS, type IconName } from "../icons";

  let { name, size = 16 }: { name: IconName; size?: number } = $props();
</script>

<svg class="icon icon-{name}" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <!-- eslint-disable-next-line svelte/no-at-html-tags -->
  {@html ICONS[name]}
</svg>
