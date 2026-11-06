<script lang="ts">
  import { api } from "../api";
  import { clock } from "../format";
  import TriageEntry from "../sidebar/TriageEntry.svelte";
  import type { InboxEntry } from "../stores/inbox.svelte";
  import type { LogMessage } from "../types";
  import Popover from "../ui/Popover.svelte";

  /** A run of what came in, as one line: `12 events → 3 actions`. Each count opens what it counts, read only then. */
  let { rows, key, attach }: { rows: readonly LogMessage[]; key: string; attach: (node: HTMLElement) => (() => void) | undefined } = $props();

  const ACTED: readonly InboxEntry["action"][] = ["filed", "woke", "told", "routed", "failed"];
  /** Rows can arrive a little before the log says so; a batch says when its oldest came in. */
  const MARGIN_MS = 5000;

  const isEvent = (m: LogMessage) => m.kind === "event";
  const events = $derived(rows.filter(isEvent).reduce((n, m) => n + (Number(m.meta.items) || 1), 0));
  const actions = $derived(rows.reduce((n, m) => n + (Number(m.meta.acted) || 0) + (m.meta.triage === "legacy" ? 1 : 0), 0));
  const first = $derived(rows[0]!);
  const last = $derived(rows[rows.length - 1]!);

  let eventsOpen = $state(false);
  let actionsOpen = $state(false);
  let items = $state<readonly InboxEntry[] | undefined>();
  let loadedTo = 0;

  $effect(() => {
    if ((!eventsOpen && !actionsOpen) || loadedTo === last.id) return;
    loadedTo = last.id;
    const since = Math.min(...rows.map((m) => Number(m.meta.since) || m.createdAt));
    void api.triagedBetween(since - MARGIN_MS, last.createdAt + MARGIN_MS).then((r) => (items = r.items), () => (items = []));
  });

  const acted = $derived((items ?? []).filter((e) => ACTED.includes(e.action)));
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const close = () => {
    eventsOpen = false;
    actionsOpen = false;
  };
</script>

{#snippet list(found: readonly InboxEntry[] | undefined, heading: string, empty: string)}
  <h3 class="m-0 flex h-6 items-center px-2 text-[12px] font-medium text-ink-45">{heading}</h3>
  {#if !items}
    <p class="m-0 px-2 py-1 text-[13px] text-ink-30">Loading…</p>
  {:else if !found?.length}
    <p class="m-0 px-2 py-1 text-[13px] text-ink-30">{empty}</p>
  {:else}
    <ul class="m-0 list-none p-0">{#each found as e (e.id)}<TriageEntry {e} onclose={close} />{/each}</ul>
  {/if}
{/snippet}

<div {@attach attach} class="row pill event triage tint-muted" data-at={first.createdAt} data-key={key}>
  <div class="pill-line triage-line">
    <Popover bind:open={eventsOpen} width="w-[26rem]">
      {#snippet trigger({ toggle })}<button class="triage-count" aria-expanded={eventsOpen} onclick={toggle}>{plural(events, "event")}</button>{/snippet}
      {#snippet children()}{@render list(items, "What came in", "Nothing kept from this stretch.")}{/snippet}
    </Popover>
    {#if actions}
      <span class="triage-arrow">→</span>
      <Popover bind:open={actionsOpen} width="w-[26rem]">
        {#snippet trigger({ toggle })}<button class="triage-count" aria-expanded={actionsOpen} onclick={toggle}>{plural(actions, "action")}</button>{/snippet}
        {#snippet children()}{@render list(acted, "What Pai did, and why", "Nothing kept from this stretch.")}{/snippet}
      </Popover>
    {/if}
    <span class="when">{clock(last.createdAt)}</span>
  </div>
</div>
