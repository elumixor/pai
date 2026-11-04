<script lang="ts">
  import { api } from "../api";
  import type { ConnectorAction, ConnectorDetail } from "../types";
  import ConfirmButton from "../ui/ConfirmButton.svelte";
  import { BLOCK_TITLE, BUTTON, ERROR } from "./controls";

  /** What a connector offers: a page opened in a new tab, or something it runs here, answering with a line. */
  let { name, actions, onupdate }: { name: string; actions: readonly ConnectorAction[]; onupdate: (fresh: ConnectorDetail) => void } = $props();
  const usable = $derived(actions.filter((a) => a.url || a.runnable));
  let running = $state<string | undefined>();
  let message = $state("");
  let error = $state("");

  async function trigger(action: ConnectorAction) {
    if (action.url) {
      window.open(action.url, "_blank", "noopener");
      return;
    }
    running = action.id;
    const result = await api.runConnectorAction(name, action.id);
    running = undefined;
    error = result.error ?? "";
    message = result.data?.message ?? "";
    if (!result.error) await api.connector(name, true).then(onupdate, (e: Error) => (error = e.message));
  }
</script>

{#if usable.length}
  <section>
    <h3 class={BLOCK_TITLE}>Actions</h3>
    <div class="flex flex-wrap gap-2">
      {#each usable as action (action.id)}
        {#if action.danger}
          <ConfirmButton class={BUTTON} disabled={running === action.id} onconfirm={() => void trigger(action)}>{action.label}</ConfirmButton>
        {:else}
          <button type="button" class={BUTTON} disabled={running === action.id} onclick={() => void trigger(action)}>{action.label}</button>
        {/if}
      {/each}
    </div>
    {#if message}<p class="m-0 mt-1.5 text-[12px] text-ink-45" role="status">{message}</p>{/if}
    {#if error}<p class="{ERROR} mt-1.5" role="alert">{error}</p>{/if}
  </section>
{/if}
