<script lang="ts">
  import { keepLogo } from "../keep";

  /** Keep's own mark, wherever something points at a Keep page. */
  let { size = 16, class: classes = "" }: { size?: number; class?: string } = $props();
</script>

<img src={keepLogo()} width={size} height={size} alt="" class="shrink-0 {classes}" />
