<script lang="ts">
  import { duration } from "../format";
  import { kindIcon } from "../kinds";
  import Icon from "../ui/Icon.svelte";
  import { describeTools, type ToolGroup } from "./model";
  import ToolCall from "./ToolCall.svelte";

  /** `⚙ Ran 7 commands · 2 min`, the calls under it when opened. */
  let { group, open, ontoggle, attach = () => undefined }: { group: ToolGroup; open: boolean; ontoggle: () => void; attach?: (node: HTMLElement) => (() => void) | undefined } = $props();
  const what = $derived(describeTools(group.tools) || (group.thinking ? "Thought it over" : "Working"));
  const span = $derived(group.end > group.at ? duration(group.end - group.at) : "");
</script>

<div {@attach attach} class="row tools tint-muted" class:live={group.live} class:open data-at={group.at} data-key={group.key}>
  <button class="tools-head" onclick={ontoggle}>
    {#if group.live}<Icon name={kindIcon("tools")} size={10} />{/if}
    <span>{what}{span && group.live ? ` · ${span}` : ""}</span>
    <Icon name="chevron" size={9} />
  </button>
  <div class="tools-body">
    {#if open}
      {#if group.thinking}<div class="tool-thinking">{group.thinking}</div>{/if}
      {#each group.tools as tool, i (tool.id ?? i)}
        <ToolCall {tool} session={group.session} />
      {/each}
    {/if}
  </div>
</div>
