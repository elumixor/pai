<script lang="ts">
  import { api } from "../api";
  import type { ConnectorSummary } from "../types";
  import Switch from "../ui/Switch.svelte";
  import { BLOCK_TITLE } from "./controls";

  /** Which channels may send without a press on the card. Every channel starts off. */
  let { connectors }: { connectors: readonly ConnectorSummary[] | undefined } = $props();

  const CHANNELS = [
    { id: "email", label: "Email", connector: "email" },
    { id: "telegram", label: "Telegram", connector: "telegram" },
    { id: "whatsapp", label: "WhatsApp", connector: "whatsapp" },
    { id: "linkedin", label: "LinkedIn messages", connector: "linkedin" },
    { id: "post", label: "LinkedIn posts", connector: "linkedin" },
  ];

  let policies = $state<Record<string, "ask" | "auto"> | undefined>();
  $effect(() => void api.draftPolicies().then((p) => (policies = p)));
  const shown = $derived(CHANNELS.filter((c) => connectors?.some((x) => x.name === c.connector && x.connected)));

  async function set(channel: string, auto: boolean) {
    const { data } = await api.setDraftPolicy(channel, auto ? "auto" : "ask");
    if (data) policies = data;
  }
</script>

{#if policies && shown.length}
  <section class="mt-6">
    <h3 class="{BLOCK_TITLE} m-0 mb-1">Send without asking</h3>
    <p class="m-0 mb-2 text-[12px] text-ink-45">Off: every message waits for your Send. On: agents send on that channel by themselves, to anyone, and you hear only when one fails.</p>
    <ul class="m-0 list-none space-y-1.5 p-0">
      {#each shown as channel (channel.id)}
        <li class="flex items-center justify-between gap-2 text-[13px]">
          {channel.label}
          <Switch checked={policies[channel.id] === "auto"} label="{channel.label} sends without asking" onchange={(next) => void set(channel.id, next)} />
        </li>
      {/each}
    </ul>
  </section>
{/if}
