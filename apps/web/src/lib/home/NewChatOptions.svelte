<script lang="ts">
  import { Code, MessageSquare, Target } from "lucide-svelte";
  import { api } from "../api";
  import { newChat, type NewKind } from "./new-chat.svelte";

  /** What a blank chat can become: nothing chosen until Jev or the user picks. */
  const OPTIONS: { kind: NewKind; label: string; icon: typeof Code }[] = [
    { kind: "detached", label: "Detached chat", icon: MessageSquare },
    { kind: "dev", label: "Task in Dev", icon: Code },
    { kind: "goal", label: "Long-term goal", icon: Target },
  ];
  let projects = $state<{ slug: string }[]>([]);
  $effect(() => void api.projects().then((list) => (projects = list), () => {}));
</script>

<div class="m-auto flex w-full max-w-[560px] flex-col gap-3 px-4">
  <div class="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Kind of chat">
    {#each OPTIONS as o (o.kind)}
      {@const on = newChat.kind === o.kind}
      {@const sure = newChat.confidence?.kind[o.kind]}
      <button type="button" role="radio" aria-checked={on} class="flex flex-col gap-1 rounded-md border p-3 text-left transition-colors {on ? 'border-accent bg-ink-5 shadow-sm' : 'border-line hover:bg-ink-5'}" onclick={() => newChat.choose({ kind: o.kind })}>
        <o.icon size={16} class={on ? "text-accent" : "text-ink-45"} />
        <span class="flex items-baseline justify-between gap-2 text-[13px] font-medium">{o.label}{#if sure !== undefined}<span class="text-[12px] font-normal {on ? 'text-accent' : 'text-ink-30'}">{Math.round(sure * 100)}%</span>{/if}</span>
      </button>
    {/each}
  </div>
  {#if newChat.kind === "dev"}
    <select class="h-8 rounded-sm border border-line bg-surface px-2 text-[13px]" aria-label="Project" value={newChat.project ?? ""} onchange={(e) => newChat.choose({ project: e.currentTarget.value })}>
      <option value="" disabled>Pick a project</option>
      {#each projects as p (p.slug)}<option value={p.slug}>{p.slug}</option>{/each}
    </select>
  {/if}
</div>
