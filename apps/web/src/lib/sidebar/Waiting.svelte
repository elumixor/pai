<script lang="ts">
  import { Hand } from "lucide-svelte";
  import ActionLinks from "../chat/ActionLinks.svelte";
  import { api } from "../api";
  import { desk, PAI } from "../desk.svelte";
  import { ago } from "../format";
  import { navigate } from "../router.svelte";
  import { openAgent } from "../shell/open.svelte";
  import type { Need } from "../types";

  /** What waits on the user, on top of the inbox: answered here with one tap, or opened where it was asked. */
  let { onclose }: { onclose: () => void } = $props();

  /** A draft's card holds fields worth seeing, so it is answered in its chat. */
  const answerable = (n: Need) => n.kind !== "draft";

  function open(n: Need) {
    onclose();
    if (n.session && desk.threadOf(n.session) && !desk.threadOf(n.session)?.agent) return navigate({ name: "thread", param: n.session });
    openAgent(n.agent && n.agent !== PAI ? n.agent : PAI);
  }

  async function answer(n: Need, text: string) {
    await api.answerNeed(n.id, text);
    await Promise.all([desk.refreshNeeds(), desk.refreshAgents()]);
  }
</script>

{#if desk.needs.length}
  <section class="mb-2 border-b border-line pb-2" aria-label="Waiting on you">
    <h3 class="m-0 flex items-center gap-1.5 px-2 pt-1 pb-1.5 text-[12px] font-medium text-hand"><Hand size={12} /> Waiting on you · {desk.needs.length}</h3>
    <ul class="m-0 max-h-72 list-none overflow-y-auto p-0">
      {#each desk.needs as need (need.id)}
        <li class="rounded-sm px-2 py-1.5 hover:bg-ink-5">
          <button class="block w-full text-left" onclick={() => open(need)}>
            <span class="line-clamp-2 text-[13px]">{need.question}</span>
            <span class="block text-[12px] text-ink-45">{need.from} · {ago(need.createdAt)}</span>
          </button>
          {#if answerable(need) && (need.options.length || need.actions?.length)}
            <div class="mt-1 flex flex-wrap gap-1">
              <ActionLinks actions={need.actions ?? []} class="inline-flex h-6 items-center rounded-sm bg-accent px-2 text-[12px] text-accent-ink no-underline" />
              {#each need.options as option (option)}
                <button class="h-6 rounded-sm bg-ink-5 px-2 text-[12px] transition-colors hover:bg-ink-10" onclick={() => void answer(need, option)}>{option}</button>
              {/each}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  </section>
{/if}
