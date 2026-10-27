<script lang="ts">
  import { api } from "../api";
  import type { Connector, ConnectorState } from "../types";
  import Icon from "../ui/Icon.svelte";

  /** The signed-in outside channels: whether each is connected, and the link that fixes it when it is not. */
  let connectors = $state<Connector[] | undefined>();
  let error = $state("");
  const LABEL: Record<ConnectorState, string> = { signed_in: "connected", signed_out: "not connected", broken: "needs attention" };
  const STATE: Record<ConnectorState, string> = { signed_in: "on", signed_out: "off", broken: "not-configured" };
  $effect(() => void api.connectors().then((list) => (connectors = list), (e: Error) => (error = e.message)));
</script>

<h2 class="dash-title">Connectors <span class="dim">the channels pai acts in, signed in as you</span></h2>
{#if error}
  <p class="hint">{error}</p>
{:else if !connectors}
  <p class="hint">…</p>
{:else if !connectors.length}
  <div class="empty"><Icon name="link" size={24} /><p class="dim">No connectors are installed on this pai.</p></div>
{:else}
  <div class="cards wide" data-testid="connectors">
    {#each connectors as c (c.name)}
      <section class="card module {c.status.state === 'signed_in' ? 'on' : 'off'}">
        <header class="mod-head">
          <span class="mod-icon"><Icon name={c.name.includes("mail") ? "mail" : c.name.includes("telegram") ? "send" : c.name.includes("linkedin") ? "users" : "message"} size={15} /></span>
          <h3>{c.title}</h3>
          <span class="chip state-{STATE[c.status.state]}">{LABEL[c.status.state]}</span>
          <span class="grow"></span>
          {#if c.status.fix}<a class="btn primary" href={c.status.fix.url} target="_blank" rel="noreferrer">{c.status.fix.label}</a>{/if}
        </header>
        <p class="dim">{c.description}</p>
        {#if c.status.detail}<div class="kv"><span class="k">status</span><span class="v">{c.status.detail}</span></div>{/if}
        {#if c.tools.length}<div class="chips tools">{#each c.tools as name (name)}<span class="chip tool">{name}</span>{/each}</div>{/if}
        {#if c.events.length}<div class="kv"><span class="k">events</span><span class="v">{c.events.map((e) => e.kind).join(", ")}</span></div>{/if}
        {#if c.canSend}<div class="kv"><span class="k">sends</span><span class="v">read back after every send</span></div>{/if}
      </section>
    {/each}
  </div>
{/if}
