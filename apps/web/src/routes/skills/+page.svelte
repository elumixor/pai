<script lang="ts">
  import { ChevronRight } from "lucide-svelte";
  import { api } from "$lib/api";
  import Markdown from "$lib/components/Markdown.svelte";
  import Page from "$lib/components/Page.svelte";
  import { notices } from "$lib/stores/notices.svelte";
  import type { ContextItem } from "$lib/types";

  let skills = $state<ContextItem[] | null>(null);
  let open = $state<string | null>(null);

  $effect(() => {
    api.context().then((context) => (skills = context.items.filter((i) => i.kind === "skill")), notices.error.bind(notices));
  });
</script>

<Page title="Skills">
  {#if !skills}
    <div class="space-y-2">{#each [1, 2, 3] as row (row)}<div class="h-12 animate-pulse bg-sunken"></div>{/each}</div>
  {:else}
    <ul class="divide-y divide-line border border-line" data-testid="skills">
      {#each skills as skill (skill.source + skill.name)}
        <li>
          <button class="flex w-full items-start gap-2 px-4 py-3 text-left hover:bg-sunken" onclick={() => (open = open === skill.name ? null : skill.name)}>
            <ChevronRight size={14} class="mt-1 shrink-0 transition-transform {open === skill.name ? 'rotate-90' : ''}" />
            <span class="min-w-0">
              <span class="font-semibold">{skill.name}</span>
              <span class="block text-[14px] text-muted">{skill.description}</span>
            </span>
          </button>
          {#if open === skill.name && skill.body}<div class="px-10 pb-4"><Markdown text={skill.body} /></div>{/if}
        </li>
      {:else}
        <li class="px-4 py-6 text-center text-muted">No skills are loaded.</li>
      {/each}
    </ul>
  {/if}
</Page>
