<script lang="ts">
  import { api } from "../api";
  import { desk } from "../desk.svelte";
  import { md } from "../markdown";

  /**
   * What an agent knows and runs with: its own files (where things stand first), and over them whom it reports to and
   * whether what it hears goes on up. A repo's notes are its CLAUDE.md and README, which belong to the dev app now: a
   * project's page says where to read them.
   */
  let { slug }: { slug: string } = $props();
  let files = $state<{ name: string; text: string }[] | undefined>();
  const agent = $derived(desk.bySlug(slug));

  $effect(() => {
    files = undefined;
    void api
      .agentInstructions(slug)
      .then((notes) => (files = [...notes.files].sort((x, y) => Number(y.name === "STATE.md") - Number(x.name === "STATE.md"))))
      .catch(() => (files = []));
  });

  async function flipBubble() {
    if (!agent) return;
    await api.configureAgent(agent.slug, { bubble: agent.bubble === false });
    await desk.refreshAgents();
  }
</script>

<div class="agent-view">
  <div class="agent-notes">
    {#if agent && slug !== "pai"}
      <p class="agent-reports">Reports to {desk.nameOf(agent.parent ?? "pai")} · <button class="info-link" title="whether reports it receives from the agents under it go on up to its own parent" onclick={flipBubble}>{agent.bubble === false ? "keeps what it hears" : "passes reports up"}</button></p>
    {/if}
    {#if !files}
      <div class="skeleton skeleton-lines" aria-hidden="true">{#each [72, 54, 86, 40, 66, 48] as w (w)}<span class="sk-line" style="--w: {w}%"></span>{/each}</div>
    {:else if files.length}
      {#each files as f (f.name)}
        <section class="agent-note"><h3 class="agent-note-name">{f.name === "STATE.md" ? "Where things stand" : f.name}</h3><div class="agent-note-body" {@attach md(f.text)}></div></section>
      {/each}
    {:else}
      <p class="info-dim">Nothing written yet.</p>
    {/if}
  </div>
</div>
