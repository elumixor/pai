<script lang="ts">
  import { api } from "../api";
  import { md } from "../markdown";
  import type { LogMessage } from "../types";
  import Icon from "../ui/Icon.svelte";

  /**
   * A draft as the thing it will become: an email with its from, to, cc and subject; a message with its recipient;
   * a post with just its words — editable in place, with Send and Discard on the card. The card is the approval: what
   * goes out is what it holds when he presses Send. Its agent's answer (`verified`, `unverified`, `not_sent`)
   * comes back onto it.
   */
  type Draft = NonNullable<LogMessage["meta"]["draft"]>;
  let { id, draft, from, message, onchanged, attach = () => undefined }: { id: number; draft: Draft; from?: string; message?: LogMessage; onchanged: () => void; attach?: (node: HTMLElement) => (() => void) | undefined } = $props();

  const SHAPE: Record<Draft["channel"], readonly { readonly key: "account" | "to" | "cc" | "subject"; readonly label: string }[]> = {
    email: [
      { key: "account", label: "From" },
      { key: "to", label: "To" },
      { key: "cc", label: "Cc" },
      { key: "subject", label: "Subject" },
    ],
    telegram: [{ key: "to", label: "To" }],
    whatsapp: [{ key: "to", label: "To" }],
    linkedin: [{ key: "to", label: "To" }],
    post: [],
  };
  const WHAT: Record<Draft["channel"], string> = { email: "Email", telegram: "Telegram", whatsapp: "WhatsApp", linkedin: "LinkedIn message", post: "LinkedIn post" };
  const SAID: Record<string, string> = {
    verified: "sent — read back where it went",
    unverified: "taken, but it could not be read back: it may already have arrived, so it was not sent again",
    not_sent: "nothing left — it is safe to try again",
  };

  // svelte-ignore state_referenced_locally
  let fields = $state<Record<string, string>>({ ...draft.fields } as Record<string, string>);
  let busy = $state(false);
  let note = $state("");
  let localStatus = $state<Draft["status"] | undefined>();
  const status = $derived(localStatus ?? draft.status);
  const editable = $derived(status === "pending");
  let saving: ReturnType<typeof setTimeout> | undefined;

  /** A keystroke is kept, so a draft he edited and left survives a reload. */
  function keep() {
    clearTimeout(saving);
    saving = setTimeout(() => void api.editDraft(id, fields), 600);
  }

  async function send() {
    busy = true;
    note = "sending…";
    const result = await api.sendDraft(id, fields);
    busy = false;
    if (result.error) return void (note = result.error);
    note = "";
    localStatus = "sending";
    onchanged();
  }

  async function discard() {
    busy = true;
    const result = await api.discardDraft(id);
    busy = false;
    if (result.error) return void (note = result.error);
    localStatus = "dropped";
    onchanged();
  }
</script>

<div {@attach attach} class="row draft-card {status}" data-draft={id} data-message={message?.id} data-at={message?.createdAt} data-key={message ? `m${message.id}` : `d${id}`} data-testid="draft">
  <div class="draft-head"><Icon name="send" size={12} /><b>{WHAT[draft.channel]}</b>{#if from}<span class="draft-who">{from}</span>{/if}<span class="draft-id">#{id}</span></div>
  {#each SHAPE[draft.channel] as f (f.key)}
    {#if editable || fields[f.key]}
      <label class="draft-field"><span class="draft-label">{f.label}</span><input class="draft-input" bind:value={fields[f.key]} placeholder={f.label} disabled={!editable || busy} oninput={keep} /></label>
    {/if}
  {/each}
  {#if editable}
    <textarea class="draft-body" rows="8" aria-label="Message" bind:value={fields.body} disabled={busy} oninput={keep}></textarea>
  {:else}
    <div class="draft-read" {@attach md(fields.body ?? "")}></div>
  {/if}
  {#if editable}
    <div class="draft-foot">
      <button class="opt draft-act draft-send" disabled={busy} onclick={send}>Send</button>
      <button class="opt draft-act faint" disabled={busy} onclick={discard}>Discard</button>
      <span class="draft-note">{note}</span>
    </div>
  {:else}
    <div class="draft-foot">
      <span class="draft-state {draft.state ?? status}">{draft.state ? SAID[draft.state] : status === "sending" ? "sending — with its agent now" : status}</span>
      {#if draft.note}<span class="draft-note">{draft.note}</span>{/if}
    </div>
  {/if}
</div>
