<script lang="ts">
  import "../app.css";
  import { Menu } from "lucide-svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { auth } from "$lib/auth.svelte";
  import Nav from "$lib/components/shell/Nav.svelte";
  import { notices } from "$lib/stores/notices.svelte";

  let { children } = $props();
  let drawer = $state(false);
  const signingIn = $derived(page.url.hash.startsWith("#/sign-in"));

  $effect(() => void auth.load());
  $effect(() => {
    if (auth.loaded && !auth.error && !auth.signedIn && !signingIn) void goto("#/sign-in", { replaceState: true });
  });
</script>

{#if auth.error}
  <div class="grid h-dvh place-items-center p-6 text-center">
    <div class="max-w-sm space-y-3">
      <p class="text-lg font-bold">pai could not start</p>
      <p class="text-muted">{auth.error}</p>
      <button class="border border-line px-3 py-1.5" onclick={() => location.reload()}>Reload</button>
    </div>
  </div>
{:else if !auth.loaded}
  <div class="grid h-dvh place-items-center"><div class="size-5 animate-spin rounded-full border-2 border-line border-t-ink"></div></div>
{:else if signingIn || !auth.signedIn}
  {@render children()}
{:else}
  <div class="flex h-dvh overflow-hidden">
    <aside class="w-64 shrink-0 border-r border-line bg-bg max-md:hidden"><Nav /></aside>
    {#if drawer}
      <button class="fixed inset-0 z-30 bg-ink/30 md:hidden" aria-label="Close menu" onclick={() => (drawer = false)}></button>
      <aside class="fixed inset-y-0 left-0 z-40 w-72 border-r border-line bg-bg md:hidden"><Nav onnavigate={() => (drawer = false)} /></aside>
    {/if}
    <main class="relative min-w-0 flex-1 bg-surface">
      <button class="absolute top-2 left-2 z-10 grid size-8 place-items-center text-muted md:hidden" aria-label="Menu" onclick={() => (drawer = true)}><Menu size={18} /></button>
      {@render children()}
    </main>
  </div>
{/if}

<div class="pointer-events-none fixed right-4 bottom-4 z-50 flex flex-col gap-2" aria-live="polite">
  {#each notices.list as notice (notice.id)}
    <p class="pointer-events-auto max-w-sm border border-line bg-surface px-3 py-2 text-danger shadow-sm">{notice.text}</p>
  {/each}
</div>
