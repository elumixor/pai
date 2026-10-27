<script lang="ts">
  import { api } from "$lib/api";
  import { notices } from "$lib/stores/notices.svelte";
  import type { LogMessage } from "$lib/types";

  /** An outgoing message to approve: edited in place, sent as it stands when Send is pressed. */
  let { message }: { message: LogMessage } = $props();
  const draft = $derived(message.meta.draft);
  let fields = $state<Record<string, string>>({});
  let busy = $state(false);

  $effect(() => {
    if (draft) fields = { ...(draft.fields as Record<string, string>) };
  });

  const STATE_LABEL = { verified: "Sent — seen in the conversation", unverified: "Sent — not confirmed yet", not_sent: "Not sent" } as const;

  async function act(kind: "send" | "discard") {
    const id = message.meta.draftId;
    if (!id) return;
    busy = true;
    try {
      if (kind === "send") await api.sendDraft(id, fields);
      else await api.discardDraft(id);
    } catch (error) {
      notices.error(error);
    } finally {
      busy = false;
    }
  }
</script>

{#if draft}
  {@const pending = draft.status === "pending"}
  <div class="border border-line bg-surface" data-testid="draft">
    <div class="flex items-center gap-2 border-b border-line px-4 py-2 text-[12px] text-muted">
      <span class="font-semibold tracking-wide uppercase">{draft.channel} draft</span>
      <span class="ml-auto">{draft.state ? STATE_LABEL[draft.state] : draft.status}</span>
    </div>
    <div class="space-y-1.5 px-4 py-3">
      {#each ["account", "to", "cc", "subject"] as key (key)}
        {#if draft.fields[key as keyof typeof draft.fields] !== undefined}
          <label class="flex items-center gap-2 text-[13px]">
            <span class="w-16 text-muted capitalize">{key}</span>
            <input class="min-w-0 flex-1 bg-transparent px-1 py-0.5 outline-none focus:bg-sunken" readonly={!pending} bind:value={fields[key]} />
          </label>
        {/if}
      {/each}
      <textarea class="min-h-32 w-full resize-y bg-transparent px-1 py-1 outline-none focus:bg-sunken" readonly={!pending} bind:value={fields.body} aria-label="Message"></textarea>
    </div>
    {#if pending}
      <div class="flex justify-end gap-2 border-t border-line px-4 py-2">
        <button class="px-3 py-1 text-muted hover:text-ink" disabled={busy} onclick={() => act("discard")}>Discard</button>
        <button class="bg-ink px-4 py-1 text-bg disabled:opacity-40" disabled={busy || !fields.body?.trim()} onclick={() => act("send")}>Send</button>
      </div>
    {:else if draft.note}
      <p class="border-t border-line px-4 py-2 text-[12px] text-muted">{draft.note}</p>
    {/if}
  </div>
{/if}
