<script lang="ts">
  import Sheet from "../ui/Sheet.svelte";

  /** Every key the client answers to, read-only. ⌘? (⌘⇧/) opens and closes it from anywhere. */
  let { open = $bindable(false) }: { open?: boolean } = $props();
  let sheet = $state<Sheet>();

  const KEYBINDINGS: readonly (readonly [keys: string, what: string])[] = [
    ["⌘?", "These keyboard shortcuts"],
    ["⌘K", "Find a thread, an agent, a setting, or run a command"],
    ["⌘⇧,", "Settings"],
    ["⌘\\", "Show or hide the sidebar"],
    ["⌘N", "A new thread"],
    ["⌘W", "Close a new thread that was not started"],
    ["⌃L", "Focus the message box"],
    ["⌘F", "Find in the open conversation"],
    ["j k · h l", "Move · fold, unfold, in the sidebar"],
    ["/", "At the start of a message: a slash command (skills, plugins, built-ins)"],
    ["Right click · two-finger swipe left", "On a message: reply to it"],
  ];

  // With ⌘ held macOS can report "/" instead of "?", and other layouts have "?" on another key: both are checked.
  const isKeybindingsKey = (event: KeyboardEvent) => (event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && (event.code === "Slash" || event.key === "?");

  function keydown(event: KeyboardEvent) {
    if (!isKeybindingsKey(event)) return;
    event.preventDefault();
    if (open) void sheet?.close();
    else open = true;
  }
</script>

<svelte:window onkeydown={keydown} />

{#if open}
  <Sheet bind:this={sheet} label="Keyboard shortcuts" onclose={() => (open = false)}>
    {#snippet head()}<h2 class="m-0 text-[15px] font-medium">Keyboard shortcuts</h2>{/snippet}
    <dl class="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
      {#each KEYBINDINGS as [keys, what] (keys)}
        <dt><kbd class="rounded-xs bg-ink-5 px-1.5 py-0.5 font-mono text-[12px] text-ink-70">{keys}</kbd></dt>
        <dd class="m-0 text-ink-45">{what}</dd>
      {/each}
    </dl>
  </Sheet>
{/if}
