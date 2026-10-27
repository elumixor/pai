<script lang="ts">
  import { attachmentUrl } from "../api";
  import Icon from "../ui/Icon.svelte";
  import { fileSize, KEPT } from "./model";

  /**
   * The pictures and files a message came with. One picture keeps its own shape; several become the grid every chat
   * draws (two side by side, three as a large one plus two, four as 2×2, more with "+N" on the last tile). A file
   * reads as the thing he attached, with its own name and size, opening the copy the box kept.
   */
  let { images = [], files = [] }: { images?: readonly string[]; files?: readonly { file: string; name: string; size: number }[] } = $props();
  const TILES = 4;
  const LAYOUT = ["", "one", "two", "three", "four"] as const;
  const url = (src: string) => (KEPT.test(src) ? attachmentUrl(src) : src);
  const shown = $derived(images.slice(0, TILES).map(url));
  const hidden = $derived(images.length - shown.length);
</script>

{#if shown.length}
  <div class="row-images {LAYOUT[Math.min(shown.length, TILES)]}">
    {#each shown as src, i (i)}
      <a href={src} target="_blank" rel="noopener"><img {src} alt="attached" loading="lazy" />{#if hidden > 0 && i === shown.length - 1}<span class="more-count">+{hidden}</span>{/if}</a>
    {/each}
  </div>
{/if}
{#if files.length}
  <div class="row-files">
    {#each files as f (f.file)}
      <a class="row-file" href="{attachmentUrl(f.file)}?name={encodeURIComponent(f.name)}" target="_blank" rel="noopener" title="{f.name} · {fileSize(f.size)}">
        <Icon name="file" size={13} /><span class="row-file-name ellipsis">{f.name}</span><span class="row-file-size">{fileSize(f.size)}</span>
      </a>
    {/each}
  </div>
{/if}
