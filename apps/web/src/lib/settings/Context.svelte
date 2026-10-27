<script lang="ts">
  import { api } from "../api";
  import type { ContextItem } from "../types";
  import Icon from "../ui/Icon.svelte";

  /**
   * Everything a session is given — instructions, memory, skills, tools — with which kinds of session see each, the
   * editable ones written in place.
   */
  let data = $state<{ surfaces: string[]; items: ContextItem[] } | undefined>();
  let error = $state("");
  let open = $state<ContextItem | undefined>();
  let text = $state("");
  let note = $state("");
  const GROUPS: Record<ContextItem["kind"], string> = { instruction: "Instructions", memory: "Memory", skill: "Skills", tool: "Tools" };
  const SURFACE: Record<string, string> = {
    chat: "a conversation with the assistant (a Telegram topic, pai claude, a thread in the app)",
    task: "a task session: its own topic, the workspace or a context project as cwd",
    code: "a coding session in a repository",
    terminal: "claude started in a terminal on this machine — not through pai",
  };
  const load = () => api.context().then((d) => (data = d), (e: Error) => (error = e.message));
  $effect(() => void load());

  function pick(item: ContextItem) {
    open = item;
    text = item.body ?? "";
    note = "";
  }
  async function save() {
    if (!open) return;
    const result = await api.saveContext(open.name, text);
    note = result.error ?? "saved";
    if (!result.error) void load();
  }
</script>

<h2 class="dash-title">Context <span class="dim">everything a session is given, and who sees it</span></h2>
{#if error}
  <p class="hint">{error}</p>
{:else if !data}
  <p class="hint">…</p>
{:else}
  {@const surfaces = data.surfaces}
  <div class="ctx-split" data-testid="skills">
    <div class="ctx-list">
      {#each Object.keys(GROUPS) as kind (kind)}
        {@const items = data.items.filter((i) => i.kind === kind)}
        <h3 class="section-title">{GROUPS[kind as ContextItem["kind"]]}</h3>
        <div class="ctx-row head"><span>what</span><span class="dim">from</span>{#each surfaces as s (s)}<span class="ctx-cell label" title={SURFACE[s] ?? s}>{s}</span>{/each}<span></span></div>
        {#each items as item (item.name + item.source)}
          <button class="ctx-row" title={item.description} onclick={() => pick(item)}>
            <span class="ctx-name ellipsis">{item.name}{#if item.project}<span class="tag">{item.project}</span>{/if}</span>
            <span class="ctx-desc dim ellipsis">{item.description}</span>
            {#each surfaces as s (s)}<span class="ctx-cell" class:on={item.surfaces.includes(s)} title="{s}: {item.surfaces.includes(s) ? 'sees it' : 'does not'}">{item.surfaces.includes(s) ? "●" : "·"}</span>{/each}
            {#if item.editable}<Icon name="pencil" size={12} />{:else}<span class="spacer"></span>{/if}
          </button>
        {:else}
          <p class="hint">none</p>
        {/each}
      {/each}
    </div>
    <div class="ctx-editor panel">
      {#if open}
        <header class="panel-head"><Icon name="book" size={13} /><h2 class="ellipsis">{open.name}</h2><span class="dim ellipsis">{open.source}</span><span class="grow"></span><span class="note">{note}</span>{#if open.editable}<button class="btn" onclick={save}>Save</button>{/if}</header>
        {#if open.editable}
          <textarea class="ctx-body ctx-edit" bind:value={text} spellcheck="false" aria-label="{open.name}"></textarea>
        {:else}
          <pre class="ctx-body">{open.body ?? ""}</pre>
        {/if}
      {:else}
        <div class="empty"><Icon name="book" size={24} /><p class="dim">Pick an item to read or edit it.</p></div>
      {/if}
    </div>
  </div>
{/if}
