<script lang="ts">
  import { api } from "../api";
  import { desk } from "../desk.svelte";
  import type { ProjectSummary } from "../types";
  import { dialogs } from "../ui/dialogs.svelte";
  import Icon from "../ui/Icon.svelte";

  /** The places sessions run in: contexts (work with a voice but no code) and the repositories. */
  let error = $state("");
  const contexts = $derived(desk.projects.filter((p) => p.kind === "context"));
  const repos = $derived(desk.projects.filter((p) => p.kind !== "context"));

  async function create() {
    const answer = await dialogs.ask({
      title: "New context project",
      description: "A project that is not code: a directory with its own CLAUDE.md (voice, preferences) and its own memory. Travel, hiring, a client.",
      fields: [
        { name: "name", label: "Name", placeholder: "Travel", required: true },
        { name: "about", label: "What it is for", placeholder: "Finding the next role: tracking applications, drafting messages in my voice." },
      ],
      submit: "Create",
    });
    if (!answer) return;
    const result = await api.createContextProject(answer.name ?? "", answer.about ?? "");
    error = result.error ?? "";
    await desk.load();
  }
</script>

{#snippet row(p: ProjectSummary)}
  <div class="auto-row">
    <Icon name={p.kind === "context" ? "book" : "code"} size={14} />
    <div class="auto-text"><span class="setting-title">{p.slug}</span><span class="dim ellipsis">{p.summary || p.path}</span></div>
    <span class="tag">{p.kind ?? "repo"}</span>
    {#if p.repo}<a class="iconbtn" href={p.repo} target="_blank" rel="noreferrer" title={p.repo}><Icon name="github" size={13} /></a>{/if}
    <a class="iconbtn" href="#/project/{encodeURIComponent(p.slug)}" title="its page: threads, tasks"><Icon name="external" size={13} /></a>
  </div>
{/snippet}

<h2 class="dash-title">Projects <span class="grow"></span><button class="btn primary" onclick={create}><Icon name="plus" size={13} /><span>New context project</span></button></h2>
{#if error}<p class="hint">{error}</p>{/if}
<h3 class="section-title">Contexts</h3>
{#if contexts.length}<div class="auto-list">{#each contexts as p (p.slug)}{@render row(p)}{/each}</div>{:else}<p class="hint">None yet. Repositories are projects on their own; a context is for work that has a voice but no code.</p>{/if}
<h3 class="section-title">Repositories</h3>
{#if repos.length}<div class="auto-list">{#each repos as p (p.slug)}{@render row(p)}{/each}</div>{:else}<p class="hint">No repositories: they come from the dev module.</p>{/if}
