<script lang="ts">
  import { Download, Trash2 } from "lucide-svelte";
  import { api } from "../api";
  import AgentSheet from "../context/AgentSheet.svelte";
  import ConfirmButton from "../ui/ConfirmButton.svelte";
  import { PAI } from "../desk.svelte";
  import Sheet from "../ui/Sheet.svelte";

  /** General's own bar buttons: download all of it as one markdown file, and clear it for good behind a confirmation. */
  const ICON = "grid size-7 shrink-0 place-items-center rounded-sm transition-colors hover:bg-ink-5 hover:text-ink";
  const BLANK_NOTE = "Nothing is known about the user yet.";
  const BUTTON = "inline-flex h-8 items-center gap-2 rounded-sm bg-ink-5 px-3 text-[13px] transition-colors hover:bg-ink-10 disabled:opacity-50";

  let confirming = $state(false);
  let sheet = $state<Sheet>();
  let downloading = $state(false);
  let downloadError = $state("");
  let resetError = $state("");
  let erasing = $state(false);
  /** What pai remembers, to choose over: empty, there is nothing to choose. */
  let remembered = $state<string | undefined>();
  let clearMemory = $state(false);
  let reviewing = $state(false);

  async function download() {
    downloading = true;
    downloadError = "";
    try {
      const { text } = await api.snapshot();
      const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `pai-snapshot-${new Date().toISOString().slice(0, 10)}.md`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (error) {
      downloadError = (error as Error).message;
    } finally {
      downloading = false;
    }
  }

  async function erase() {
    erasing = true;
    const result = await api.resetGeneral(clearMemory);
    erasing = false;
    if (result.error) resetError = result.error;
    else void sheet?.close();
  }
  function ask() {
    resetError = "";
    downloadError = "";
    clearMemory = false;
    remembered = undefined;
    confirming = true;
    void api.agentSheet(PAI).then((found) => (remembered = found.memory[0]?.text ?? ""));
  }

  /** Only the note a blank memory starts with: nothing worth asking about. */
  const hasMemory = $derived(Boolean(remembered?.trim()) && !remembered?.includes(BLANK_NOTE));
</script>

<button class="{ICON} {downloadError ? 'text-hot' : 'text-ink-45'}" aria-label="Download everything" title={downloadError || "Download everything"} disabled={downloading} onclick={download}><Download size={16} /></button>
<button class="{ICON} text-ink-45" aria-label="Clear General" title="Clear General" onclick={ask}><Trash2 size={16} /></button>

{#if confirming}
  <Sheet bind:this={sheet} label="Clear General" onclose={() => (confirming = false)}>
    {#snippet head()}<h2 class="m-0 text-[15px] font-medium">Clear General?</h2>{/snippet}
    <p class="m-0 text-[13px] text-ink-70">Erases this conversation, its journal, tasks and workers, for good. Plain threads, Keep and routines stay.</p>
    {#if hasMemory}
      <div class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-sm bg-ink-5 px-3 py-2 text-[13px]">
        <label class="flex min-w-0 flex-1 items-center gap-2"><input type="checkbox" bind:checked={clearMemory} /> Also clear what General remembers</label>
        <button type="button" class="text-ink-45 hover:text-ink" onclick={() => (reviewing = true)}>Review memory</button>
      </div>
      {#if clearMemory}<p class="mt-2 mb-0 text-[13px] text-ink-70">General then starts over by getting to know you.</p>{/if}
    {:else if remembered !== undefined}
      <p class="mt-2 mb-0 text-[13px] text-ink-70">General remembers nothing yet, so it starts by getting to know you.</p>
    {/if}
    {#if downloadError || resetError}<p class="mt-3 mb-0 text-[13px] text-hot" role="alert">{downloadError || resetError}</p>{/if}
    <div class="mt-4 flex flex-wrap items-center gap-2">
      <button class={BUTTON} disabled={downloading} onclick={download}><Download size={16} /> {downloading ? "Preparing backup" : "Download backup"}</button>
      <span class="flex-1"></span>
      <ConfirmButton class={BUTTON} disabled={erasing} confirm="Erase for good" onconfirm={erase}><Trash2 size={16} /> Clear General</ConfirmButton>
    </div>
  </Sheet>
{/if}
{#if reviewing}<AgentSheet slug={PAI} name="General" tab="memory" onclose={() => (reviewing = false)} />{/if}
