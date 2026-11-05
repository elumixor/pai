<script lang="ts">
  import { untrack } from "svelte";
  import { api } from "../api";
  import { BUTTON, ERROR, INPUT } from "../settings/controls";
  import type { ToolProviders } from "../types";

  /** A new direct MCP server, or a synced connector moving to one when `replaces` is set. */
  let { draft, oncancel, ondone }: { draft: { name: string; url: string; auth: "none" | "bearer" | "oauth"; replaces?: string }; oncancel: () => void; ondone: (next: ToolProviders) => void } = $props();

  const start = untrack(() => draft);
  let name = $state(start.name);
  let url = $state(start.url);
  let auth = $state(start.auth);
  let token = $state("");
  let busy = $state(false);
  let error = $state("");
  let waiting = $state(false);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    error = "";
    try {
      const result = await api.addServer({ name, url, auth, ...(auth === "bearer" ? { token } : {}), ...(start.replaces ? { replaces: start.replaces } : {}) });
      if ("authorize" in result) {
        window.open(result.authorize, "_blank", "noopener");
        waiting = true;
      } else ondone(await api.tools());
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<form class="space-y-3 p-5 max-sm:p-4" onsubmit={submit}>
  <h3 class="m-0 text-[15px] font-medium">{start.replaces ? `Move ${start.replaces.replace(/^claude\.ai /, "")} to pai` : "Add a server"}</h3>
  <p class="m-0 text-[12px] text-ink-45">
    {start.replaces ? "pai connects to it directly instead of through your claude.ai account. It is checked first, and only if it answers does the synced one switch off." : "An MCP server over HTTP. It is checked before it is added."}
  </p>
  <label class="block space-y-1 text-[12px] text-ink-45">Name<input class={INPUT} bind:value={name} required /></label>
  <label class="block space-y-1 text-[12px] text-ink-45">Address<input class={INPUT} type="url" bind:value={url} required /></label>
  <label class="block space-y-1 text-[12px] text-ink-45">
    Sign-in
    <select class={INPUT} bind:value={auth}>
      <option value="bearer">Token</option>
      <option value="oauth">Sign in with the provider</option>
      <option value="none">None</option>
    </select>
  </label>
  {#if auth === "bearer"}
    <label class="block space-y-1 text-[12px] text-ink-45">Token<input class={INPUT} type="password" autocomplete="off" bind:value={token} required /></label>
  {/if}
  {#if error}<p class={ERROR} role="alert">{error}</p>{/if}
  {#if waiting}
    <p class="m-0 text-[12px] text-ink-70">Finish signing in in the tab that opened, then come back.</p>
    <button type="button" class={BUTTON} onclick={async () => ondone(await api.tools())}>Done</button>
  {:else}
    <div class="flex gap-2">
      <button type="submit" class={BUTTON} disabled={busy}>{busy ? "Checking…" : start.replaces ? "Move" : "Add"}</button>
      <button type="button" class={BUTTON} onclick={oncancel}>Cancel</button>
    </div>
  {/if}
</form>
