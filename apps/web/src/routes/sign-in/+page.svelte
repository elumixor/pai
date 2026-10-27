<script lang="ts">
  import { goto } from "$app/navigation";
  import { auth } from "$lib/auth.svelte";

  let host = $state<HTMLDivElement>();

  $effect(() => {
    if (auth.signedIn) {
      void goto("#/", { replaceState: true });
      return;
    }
    if (!host) return;
    const mounted = auth.mountSignIn(host);
    return () => void mounted.then((unmount) => unmount());
  });
</script>

<main class="grid min-h-dvh place-items-center p-4">
  <div class="space-y-6">
    <h1 class="text-center font-display text-4xl font-bold tracking-tight">pai</h1>
    <div bind:this={host}></div>
  </div>
</main>
