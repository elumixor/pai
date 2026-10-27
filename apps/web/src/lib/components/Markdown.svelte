<script lang="ts">
  import { render } from "$lib/markdown";

  let { text }: { text: string } = $props();
  const html = $derived(render(text));
</script>

<!-- `render` sanitizes with DOMPurify before anything reaches the page. -->
<div class="prose-pai">{@html html}</div>
