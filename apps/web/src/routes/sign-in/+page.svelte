<script lang="ts">
  import { goto } from "$app/navigation";
  import { auth } from "$lib/auth.svelte";

  let host = $state<HTMLDivElement>();
  // Where to go once signed in, when the daemon sent the browser here (`#/sign-in?next=/auth/handoff?…`); only a
  // path on this host, so the link cannot send anyone elsewhere.
  const wanted = new URLSearchParams(location.hash.split("?")[1] ?? "").get("next");
  const next = wanted && /^\/(?!\/)/.test(wanted) ? wanted : null;

  $effect(() => {
    if (auth.signedIn) {
      if (next) location.assign(next);
      else void goto("#/", { replaceState: true });
      return;
    }
    if (!host) return;
    const mounted = auth.mountSignIn(host, next ?? "/");
    return () => void mounted.then((unmount) => unmount());
  });
</script>

<main class="grid min-h-dvh place-items-center p-4">
  <div class="space-y-6">
    <h1 class="text-center font-display text-4xl font-bold tracking-tight">pai</h1>
    <div bind:this={host}></div>
  </div>
</main>
