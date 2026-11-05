<script lang="ts">
  import { ChevronRight } from "lucide-svelte";
  import { contextPopup, type ContextPopup } from "../context/popups.svelte";
  import Switch from "../ui/Switch.svelte";
  import { vim } from "../vim.svelte";
  import { ROW, ROW_BUTTON } from "./controls";

  /** What sessions are given, each kind in a popup of its own. */
  const ENTRIES: readonly { popup: ContextPopup; title: string; note: string }[] = [
    { popup: "tools", title: "Tools", note: "What sessions can use, where each comes from, on and off" },
    { popup: "skills", title: "Skills", note: "Instructions a session loads when it needs them" },
    { popup: "instructions", title: "Instructions", note: "What sessions are told, and what pai remembers" },
  ];
</script>

<ul class="m-0 list-none p-0">
  {#each ENTRIES as entry (entry.popup)}
    <li class="border-b border-line last:border-b-0">
      <button type="button" class="{ROW} rounded-sm px-1 {ROW_BUTTON}" onclick={() => (contextPopup.open = entry.popup)}>
        <span class="w-1/4 shrink-0">{entry.title}</span>
        <span class="min-w-0 flex-1 truncate text-[12px] text-ink-45">{entry.note}</span>
        <ChevronRight size={14} class="shrink-0 text-ink-30" />
      </button>
    </li>
  {/each}
</ul>
<div class="mt-4 flex min-h-10 items-center gap-3 px-1 text-[13px]">
  <span class="flex-1">Vim keys<span class="block text-[12px] text-ink-45">In these editors and the message box, on this device</span></span>
  <Switch checked={vim.enabled} label="Vim keys" onchange={(on) => (vim.enabled = on)} />
</div>
