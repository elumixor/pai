<script lang="ts">
  import { api } from "$lib/api";
  import Page from "$lib/components/Page.svelte";
  import { notices } from "$lib/stores/notices.svelte";
  import type { Connector, ConnectorState } from "$lib/types";

  let connectors = $state<Connector[] | null>(null);
  const LABEL: Record<ConnectorState, string> = { signed_in: "Connected", signed_out: "Not connected", broken: "Needs attention" };
  const DOT: Record<ConnectorState, string> = { signed_in: "bg-accent", signed_out: "bg-faint", broken: "bg-danger" };

  $effect(() => {
    api.connectors().then((list) => (connectors = list), notices.error.bind(notices));
  });
</script>

<Page title="Connectors">
  {#if !connectors}
    <div class="space-y-2">{#each [1, 2, 3] as row (row)}<div class="h-20 animate-pulse bg-sunken"></div>{/each}</div>
  {:else if !connectors.length}
    <p class="text-muted">No connectors are installed on this pai.</p>
  {:else}
    <ul class="divide-y divide-line border border-line" data-testid="connectors">
      {#each connectors as connector (connector.name)}
        <li class="flex gap-4 px-4 py-4">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="size-2 rounded-full {DOT[connector.status.state]}"></span>
              <span class="font-semibold">{connector.title}</span>
              <span class="text-[13px] text-muted">{LABEL[connector.status.state]}{connector.status.detail ? ` · ${connector.status.detail}` : ""}</span>
            </div>
            <p class="mt-1 text-[14px] text-muted">{connector.description}</p>
            {#if connector.tools.length || connector.events.length}
              <p class="mt-1 text-[12px] text-faint">
                {connector.tools.length} tools{connector.canSend ? " · sends, read back" : ""}{connector.events.length ? ` · tells pai about ${connector.events.map((e) => e.kind).join(", ")}` : ""}
              </p>
            {/if}
          </div>
          {#if connector.status.fix}
            <a class="self-center border border-line px-3 py-1.5 text-[13px] whitespace-nowrap hover:border-ink" href={connector.status.fix.url} target="_blank" rel="noreferrer">{connector.status.fix.label}</a>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</Page>
