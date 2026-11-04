<script lang="ts">
  import { Plus } from "lucide-svelte";
  import { api, send } from "../api";
  import type { ConnectorAccounts, ConnectorDetail } from "../types";
  import ConfirmButton from "../ui/ConfirmButton.svelte";
  import { BLOCK_TITLE, BUTTON, ERROR, INPUT, ROW } from "./controls";

  /** The accounts behind a connector. Connecting happens in the tab it opens, so the list is polled until the new one shows. */
  const VALID_LABEL = /^[a-z0-9-]{1,40}$/;
  const POLL_MS = 3000;
  const POLL_FOR_MS = 5 * 60 * 1000;

  let { name, accounts, onupdate }: { name: string; accounts: ConnectorAccounts; onupdate: (fresh: ConnectorDetail) => void } = $props();
  let adding = $state(false);
  let label = $state("");
  let error = $state("");
  let waiting = $state(false);
  let stop: (() => void) | undefined;
  $effect(() => () => stop?.());

  const withLabel = (path: string, value: string) => path.replace("{label}", encodeURIComponent(value));

  function watchFor(value: string) {
    stop?.();
    waiting = true;
    const poll = setInterval(() => {
      api.connector(name, true).then(
        (fresh) => {
          if (!fresh.accounts?.items.some((item) => item.label === value)) return;
          stop?.();
          onupdate(fresh);
        },
        (e: Error) => (error = e.message),
      );
    }, POLL_MS);
    const giveUp = setTimeout(() => stop?.(), POLL_FOR_MS);
    stop = () => {
      clearInterval(poll);
      clearTimeout(giveUp);
      waiting = false;
      stop = undefined;
    };
  }

  function connect() {
    const value = label.trim().toLowerCase();
    if (!VALID_LABEL.test(value)) {
      error = "A label is letters, digits and dashes.";
      return;
    }
    error = "";
    window.open(withLabel(accounts.connectPath, value), "_blank", "noopener");
    label = "";
    adding = false;
    watchFor(value);
  }

  async function forget(account: string) {
    const result = await send(withLabel(accounts.removePath, account), {}, "DELETE");
    if (result.error) {
      error = result.error;
      return;
    }
    error = "";
    await api.connector(name).then(onupdate, (e: Error) => (error = e.message));
  }
</script>

<section>
  <h3 class={BLOCK_TITLE}>Accounts</h3>
  <ul class="m-0 list-none p-0">
    {#each accounts.items as item (item.label)}
      <li class={ROW}>
        <span class="min-w-0 flex-1 truncate">{item.label} <span class="text-ink-45">{item.detail}</span></span>
        <ConfirmButton class="h-7 shrink-0 rounded-sm px-2 text-[12px] text-ink-45 transition-colors hover:bg-ink-5 hover:text-ink" onconfirm={() => void forget(item.label)}>Forget</ConfirmButton>
      </li>
    {/each}
    <li class={ROW}>
      {#if adding}
        <!-- svelte-ignore a11y_autofocus -->
        <input class={INPUT} bind:value={label} placeholder={accounts.hint} aria-label="Account label" autofocus onkeydown={(e) => e.key === "Enter" && connect()} />
        <button type="button" class="{BUTTON} shrink-0" onclick={connect}>Connect</button>
      {:else}
        <button type="button" class="flex min-h-10 flex-1 items-center gap-2 rounded-sm text-ink-45 transition-colors hover:text-ink" onclick={() => (adding = true)}><Plus size={16} /> Connect</button>
      {/if}
    </li>
  </ul>
  {#if waiting}<p class="m-0 mt-1.5 text-[12px] text-ink-45" role="status">Finish in the tab that opened.</p>{/if}
  {#if error}<p class="{ERROR} mt-1.5" role="alert">{error}</p>{/if}
</section>
