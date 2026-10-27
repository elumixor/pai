<script lang="ts">
  import { page } from "$app/state";
  import ChatView from "$lib/components/ChatView.svelte";
  import { agents } from "$lib/stores/agents.svelte";

  const slug = $derived(page.params.slug ?? "");
</script>

{#key slug}
  <ChatView agent={slug} title={agents.name(slug)} />
{/key}
