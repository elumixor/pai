<script lang="ts">
  import { auth } from "$lib/auth.svelte";

  // Paigram opens this page in a sign-in sheet (`#/link?state=…&name=…`) and waits for `paigram://pai-auth`. The
  // address it returns to is fixed here, never taken from the link, so the page cannot hand a token to anyone else.
  const params = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const linkState = params.get("state") ?? "";
  const name = (params.get("name") ?? "").slice(0, 80) || "this phone";
  let busy = $state(false);
  let error = $state<string | null>(null);

  async function link() {
    busy = true;
    error = null;
    try {
      const response = await fetch("/auth/devices", {
        method: "POST",
        headers: { "content-type": "application/json", ...(await auth.header()) },
        body: JSON.stringify({ name }),
      });
      const answer = (await response.json()) as { token?: string; error?: string };
      if (!response.ok || !answer.token) throw new Error(answer.error ?? `HTTP ${response.status}`);
      location.assign(`paigram://pai-auth?${new URLSearchParams({ token: answer.token, state: linkState })}`);
    } catch (err) {
      error = (err as Error).message;
      busy = false;
    }
  }
</script>

<main class="empty boot sign-in">
  <h1 class="sign-in-mark">pai</h1>
  {#if !linkState}
    <p class="dim">Open this page from Paigram: Settings › pai › Sign in.</p>
  {:else}
    <p class="setting-title">Link {name} to pai?</p>
    <p class="dim">It gets its own key, which you can revoke from any signed-in device.</p>
    <button class="btn" disabled={busy} onclick={link}>{busy ? "Linking…" : "Link"}</button>
    {#if error}<p class="dim">{error}</p>{/if}
  {/if}
</main>
