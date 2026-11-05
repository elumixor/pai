<script lang="ts">
  import { ArrowLeft, Plus, Trash2 } from "lucide-svelte";
  import { api } from "../api";
  import { BUTTON, ERROR, INPUT, SKELETON, TEXTAREA } from "../settings/controls";
  import type { ContextItem } from "../types";
  import Sheet from "../ui/Sheet.svelte";
  import Switch from "../ui/Switch.svelte";
  import { descriptionOf, joinFrontmatter, splitFrontmatter, withDescription } from "./frontmatter";
  import MarkdownField from "./MarkdownField.svelte";
  import Panes from "./Panes.svelte";

  /** The skills every session can reach for: their switch, what they say about themselves, and their body. */
  let { onclose }: { onclose: () => void } = $props();

  let skills = $state<ContextItem[] | undefined>();
  let error = $state("");
  let openName = $state<string | undefined>();
  let creating = $state(false);
  let newName = $state("");
  let newDescription = $state("");

  const load = () => api.context().then((d) => (skills = d.items.filter((i) => i.kind === "skill")), (e: Error) => (error = e.message));
  $effect(() => void load());

  const open = $derived(skills?.find((s) => s.name === openName));
  // The head is kept as loaded for the life of the row; every save writes it back around the new body.
  const parts = $derived(open ? splitFrontmatter(open.body ?? "") : undefined);
  const saveFile = (name: string, text: string) => api.saveContext(name, text).then((r) => r.error);

  async function toggle(skill: ContextItem, on: boolean) {
    const result = await api.patchTools({ skill: skill.name, on }).catch((e: Error) => ((error = e.message), undefined));
    if (result) await load();
  }
  async function create(event: SubmitEvent) {
    event.preventDefault();
    const result = await api.createSkill(newName, newDescription);
    if (result.error) return void (error = result.error);
    error = "";
    creating = false;
    await load();
    openName = newName;
    newName = newDescription = "";
  }
  async function remove(name: string) {
    const result = await api.deleteSkill(name);
    if (result.error) return void (error = result.error);
    openName = undefined;
    await load();
  }
  function describe(skill: ContextItem, head: string, body: string, description: string) {
    void saveFile(skill.name, joinFrontmatter(withDescription(head, description), body)).then((e) => (e ? (error = e) : load()));
  }
</script>

<Sheet label="Skills" wide {onclose}>
  {#snippet head()}
    <div class="flex items-center gap-2">
      {#if open}<button type="button" class="hidden size-8 place-items-center rounded-sm text-ink-45 hover:bg-ink-5 max-md:grid" aria-label="Back to the list" onclick={() => (openName = undefined)}><ArrowLeft size={16} /></button>{/if}
      <h2 class="m-0 text-[14px] font-medium">Skills</h2>
    </div>
  {/snippet}
  {#if !skills}
    <div class="w-full space-y-2 p-5" aria-hidden="true">
      {#each [0, 1, 2] as i (i)}<div class="h-8 {SKELETON}"></div>{/each}
      {#if error}<p class={ERROR} role="alert">{error}</p>{/if}
    </div>
  {:else}
    <Panes detailOpen={Boolean(open || creating)}>
      {#snippet list()}
        <div class="px-4 pb-2"><button type="button" class={BUTTON} onclick={() => { openName = undefined; creating = true; }}><Plus size={14} />New skill</button></div>
        <ul class="m-0 list-none p-0">
          {#each skills! as skill (skill.name)}
            <li class="flex items-center gap-2 pr-4 {openName === skill.name ? 'bg-ink-5' : ''}">
              <button type="button" class="min-h-11 min-w-0 flex-1 py-1 pl-4 text-left {skill.on ? '' : 'opacity-50'}" onclick={() => { creating = false; openName = skill.name; }}>
                <span class="block truncate text-[13px]">{skill.name}</span>
                <span class="block truncate text-[12px] text-ink-45">{skill.description}</span>
              </button>
              <Switch checked={skill.on ?? true} label="{skill.name} on" onchange={(on) => toggle(skill, on)} />
            </li>
          {/each}
        </ul>
      {/snippet}
      {#snippet detail()}
        {#if creating}
          <form class="space-y-3 p-5 max-sm:p-4" onsubmit={create}>
            <h3 class="m-0 text-[15px] font-medium">New skill</h3>
            <p class="m-0 text-[12px] text-ink-45">A skill is instructions a session loads when its description matches what it is doing.</p>
            <label class="block space-y-1 text-[12px] text-ink-45">Name<input class={INPUT} bind:value={newName} pattern="[a-z0-9][a-z0-9-]*" required /></label>
            <label class="block space-y-1 text-[12px] text-ink-45">When to use it<textarea class="{TEXTAREA} h-20 resize-none" bind:value={newDescription} required></textarea></label>
            {#if error}<p class={ERROR} role="alert">{error}</p>{/if}
            <div class="flex gap-2">
              <button type="submit" class={BUTTON}>Create</button>
              <button type="button" class={BUTTON} onclick={() => (creating = false)}>Cancel</button>
            </div>
          </form>
        {:else if open && parts}
          {@const skill = open}
          {@const { head, body } = parts}
          {@const description = descriptionOf(head)}
          {#key skill.name}
            <div class="flex min-h-0 flex-1 flex-col gap-3 p-5 max-sm:p-4">
              <div class="flex items-center gap-2">
                <h3 class="m-0 min-w-0 flex-1 truncate text-[15px] font-medium">{skill.name}</h3>
                <button type="button" class="grid size-8 place-items-center rounded-sm text-ink-45 hover:bg-ink-5" aria-label="Delete {skill.name}" onclick={() => remove(skill.name)}><Trash2 size={15} /></button>
              </div>
              {#if error}<p class={ERROR} role="alert">{error}</p>{/if}
              {#if description !== undefined}
                <label class="block space-y-1 text-[12px] text-ink-45">When to use it<textarea class="{TEXTAREA} h-20 resize-none" value={description} onchange={(event) => describe(skill, head, body, event.currentTarget.value)}></textarea></label>
              {:else}
                <p class="m-0 text-[12px] text-ink-45">Its description spans lines: edit it in Source.</p>
              {/if}
              <MarkdownField value={description === undefined ? (skill.body ?? "") : body} label={skill.name} save={(text) => saveFile(skill.name, description === undefined ? text : joinFrontmatter(head, text))} />
            </div>
          {/key}
        {:else}
          <div class="grid flex-1 place-items-center p-8 text-center"><p class="m-0 max-w-80 text-[13px] text-ink-45">A skill is instructions a session loads when it needs them. Switched off, no session sees it.</p></div>
        {/if}
      {/snippet}
    </Panes>
  {/if}
</Sheet>
