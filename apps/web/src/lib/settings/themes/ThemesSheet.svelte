<script lang="ts">
  import type { Palette, ThemeKind } from "@desk/core";
  import { ArrowLeft, Plus, Redo2, Undo2 } from "lucide-svelte";
  import { theme } from "../../theme.svelte";
  import { isCustomId } from "../../theme/custom";
  import { ThemeEdit } from "../../theme/edit.svelte";
  import Sheet from "../../ui/Sheet.svelte";
  import { ERROR, INPUT } from "../controls";
  import ThemeEditor from "./ThemeEditor.svelte";
  import ThemeSwatch from "./ThemeSwatch.svelte";

  /**
   * Every palette and theme, and the editor, as two views of one sheet: two sheets at once would each take the same
   * Escape. While editing, whatever would close the sheet goes back to the list instead.
   */
  let { onclose }: { onclose: () => void } = $props();

  const KINDS: readonly { kind: ThemeKind; label: string }[] = [
    { kind: "light", label: "Light" },
    { kind: "dark", label: "Dark" },
  ];
  const ICON = "grid size-8 shrink-0 place-items-center rounded-sm text-ink-45 transition-colors enabled:hover:bg-ink-5 enabled:hover:text-ink disabled:opacity-40";

  let edit = $state<ThemeEdit | null>(null);
  const editing = $derived(edit?.theme);

  function open(id: string, kind: ThemeKind) {
    const target = isCustomId(id) ? id : theme.create(id).id;
    theme.pick({ id: target, kind });
    edit = new ThemeEdit(target);
  }

  function create(kind: ThemeKind) {
    const copy = theme.create(theme.choice[kind]);
    theme.pick({ id: copy.id, kind });
    edit = new ThemeEdit(copy.id);
  }

  function back() {
    theme.flush();
    edit = null;
  }

  async function beforeclose() {
    if (!edit) return true;
    back();
    return false;
  }

  const shown = (kind: ThemeKind): readonly Palette[] => theme.palettes.filter((palette) => palette.kind === kind);

  $effect(() => () => theme.flush());
</script>

<Sheet label="Themes" wide={!!editing} {onclose} {beforeclose}>
  {#snippet head()}
    {#if edit && editing}
      <div class="flex items-center gap-2">
        <button type="button" class={ICON} aria-label="Back to themes" onclick={back}><ArrowLeft size={16} /></button>
        <input class="{INPUT} max-w-64" aria-label="Theme name" value={editing.name} oninput={(event) => edit?.rename(event.currentTarget.value)} />
        <button type="button" class={ICON} aria-label="Undo" disabled={!edit.canUndo} onclick={() => edit?.undo()}><Undo2 size={16} /></button>
        <button type="button" class={ICON} aria-label="Redo" disabled={!edit.canRedo} onclick={() => edit?.redo()}><Redo2 size={16} /></button>
        {#if theme.saveError}<p class={ERROR} role="alert">{theme.saveError}</p>{/if}
      </div>
    {:else}
      <p class="m-0 text-[14px] font-medium">Themes</p>
    {/if}
  {/snippet}
  {#if edit && editing}
    <ThemeEditor {edit} current={editing} />
  {:else}
    <div class="space-y-5">
      {#each KINDS as { kind, label } (kind)}
        <div class="space-y-2">
          <p class="m-0 text-[13px] font-medium">{label}</p>
          <div class="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-2" role="radiogroup" aria-label="{label} theme">
            {#each shown(kind) as palette (palette.id)}
              <ThemeSwatch {palette} on={theme.choice[kind] === palette.id} onpick={() => theme.pick(palette)} onedit={() => open(palette.id, kind)} ondelete={() => theme.remove(palette.id)} />
            {/each}
            <button type="button" class="flex flex-col gap-1.5 rounded-md border-2 border-transparent p-1 text-left text-[12px] text-ink-45 transition-colors hover:text-ink" onclick={() => create(kind)}>
              <span class="grid h-14 w-full place-items-center rounded-sm border border-dashed border-line-2 transition-colors"><Plus size={16} /></span>
              <span class="truncate px-0.5">New theme</span>
            </button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</Sheet>
