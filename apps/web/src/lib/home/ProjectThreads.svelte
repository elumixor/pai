<script lang="ts">
  import { api } from "../api";
  import { stamp } from "../format";
  import type { DiskSession } from "../types";
  import Icon from "../ui/Icon.svelte";

  /**
   * A repo's conversations: every Claude Code session held in it, newest first, the finished ones included — the
   * tree only shows a thread while it runs, and he opens a project to find yesterday's conversation.
   */
  let { path, openThread, newThread }: { path?: string; openThread: (id: string) => void; newThread: () => void } = $props();
  const PAGE = 25;
  let limit = $state(PAGE);
  let found = $state<DiskSession[] | undefined>();

  $effect(() => {
    const at = path;
    const n = limit;
    if (!at) return void (found = []);
    void api
      .threadsIn(at, n)
      .then((list) => (found = list))
      .catch(() => (found = []));
  });
</script>

<div class="agent-view">
  <div class="thread-list">
    {#if !path}
      <p class="info-dim">This project has no directory on the box.</p>
    {:else if !found}
      <div class="skeleton skeleton-lines" aria-hidden="true">{#each [72, 54, 86, 40, 66] as w (w)}<span class="sk-line" style="--w: {w}%"></span>{/each}</div>
    {:else if !found.length}
      <p class="info-dim">No conversations in this repo yet.</p>
      <button class="opt" onclick={newThread}>Start one</button>
    {:else}
      {#each found as t (t.sessionId)}
        <button class="row pill thread-row" title="{t.title}&#10;{t.cwd}" onclick={() => openThread(t.sessionId)}>
          <span class="pill-line"><Icon name="message" size={11} /><span class="ellipsis pill-text">{t.title || t.sessionId.slice(0, 6)}</span><span class="when">{stamp(t.lastActivity)}</span></span>
        </button>
      {/each}
      {#if found.length >= limit}<button class="opt more-threads" onclick={() => (limit += PAGE)}>Show more</button>{/if}
    {/if}
  </div>
</div>
