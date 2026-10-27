<script lang="ts">
  import "../app.css";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { auth } from "$lib/auth.svelte";

  let { children } = $props();
  const signingIn = $derived(page.url.hash.startsWith("#/sign-in"));

  $effect(() => void auth.load());
  $effect(() => {
    if (auth.loaded && !auth.error && !auth.signedIn && !signingIn) void goto("#/sign-in", { replaceState: true });
  });
</script>

{#if auth.error}
  <div class="empty boot">
    <p class="setting-title">pai could not start</p>
    <p class="dim">{auth.error}</p>
    <button class="btn" onclick={() => location.reload()}>Reload</button>
  </div>
{:else if !auth.loaded}
  <div class="empty boot"><span class="spinner"></span></div>
{:else}
  {@render children()}
{/if}
