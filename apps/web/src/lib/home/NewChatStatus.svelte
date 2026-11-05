<script lang="ts">
  import { capital, projectName } from "../format";
  import { newChat } from "./new-chat.svelte";

  /** Above the box of a blank chat: what Jev picked and how sure it is; a pick the user made says so. */
  const percent = (p?: number) => (p === undefined ? "" : `${Math.round(p * 100)}%`);
  const picks = $derived(
    newChat.confidence
      ? [
          ...(newChat.kind === "dev" && newChat.project ? [{ key: "project", label: projectName(newChat.project) }] : []),
          { key: "model", label: capital(newChat.model) },
          { key: "effort", label: newChat.effort },
        ]
      : [],
  );
  const sureOf = (key: string) => (key === "project" ? newChat.confidence?.project : key === "model" ? newChat.confidence?.model : newChat.confidence?.effort);
</script>

{#if newChat.failed || picks.length}
  <div class="flex min-h-6 w-full flex-wrap items-center gap-1.5 px-1 text-[12px]" role="status" aria-live="polite">
    {#if newChat.failed}<span class="text-ink-45">Jev is unavailable, choose yourself</span>{/if}
    <div class="flex flex-wrap items-center gap-1.5">
      {#each picks as p (p.key)}
        <span class="inline-flex h-6 items-center gap-1.5 rounded-sm border border-accent bg-ink-5 px-2 font-medium">
          {p.label}
          <span class="font-normal text-ink-45">{newChat.isChosen(p.key) ? "yours" : percent(sureOf(p.key))}</span>
        </span>
      {/each}
    </div>
  </div>
{/if}
