<script lang="ts">
  import { Briefcase, Calendar, ChevronRight, ExternalLink, Mail, MessageCircle, Send } from "lucide-svelte";
  import { api } from "../api";
  import { desk } from "../desk.svelte";
  import { ago } from "../format";
  import { navigate } from "../router.svelte";
  import type { InboxEntry } from "../stores/inbox.svelte";

  /** What came in and what triage did with it: what it acted on first, what it set aside folded. No badge, nothing here asks to be read. */
  let { onclose }: { onclose: () => void } = $props();

  const ICONS: Record<string, typeof Mail> = { mail: Mail, telegram: Send, whatsapp: MessageCircle, linkedin: Briefcase, calendar: Calendar };
  const SET_ASIDE: readonly InboxEntry["action"][] = ["ignored", "muted", "filed"];

  let items = $state<readonly InboxEntry[] | undefined>();
  let open = $state<string | undefined>();
  let showSetAside = $state(false);
  let told = $state(new Set<string>());

  $effect(() => void api.triaged().then(({ items: found }) => (items = found), () => (items = [])));

  const important = $derived((items ?? []).filter((e) => !SET_ASIDE.includes(e.action)));
  const setAside = $derived((items ?? []).filter((e) => SET_ASIDE.includes(e.action)));

  /** Where it went, as they would say it. */
  function outcome(e: InboxEntry) {
    const [kind, id = ""] = (e.target ?? "").split(/:(.*)/s);
    const where = kind === "main" ? "General" : kind === "agent" ? desk.nameOf(id) : kind === "thread" ? (desk.threadOf(id)?.title ?? "a thread") : kind === "task" ? `task #${id}` : "";
    const said = { pending: "Deciding…", ignored: "Ignored", muted: "Muted", filed: where ? `Filed under ${where}` : "Filed", woke: `Woke ${where}`, told: "Told you", routed: `To ${where || "General"}`, failed: "Failed" };
    return said[e.action];
  }

  /** The model's confidence ("ignore 92% · hiring 80%") as words; anything else is already words. */
  function why(e: InboxEntry) {
    const sure = /^\w+ (\d+)%/.exec(e.note ?? "");
    return sure ? `${sure[1]}% sure` : (e.note ?? "");
  }

  function go(e: InboxEntry) {
    const [kind, id = ""] = (e.target ?? "").split(/:(.*)/s);
    if (kind === "thread" && id) navigate({ name: "thread", param: id });
    else if (kind === "agent" && id) navigate({ name: "chat", param: id });
    else if (kind === "main") navigate("home");
    else return;
    onclose();
  }

  async function tell(e: InboxEntry) {
    told = new Set([...told, e.id]);
    await api.tellAboutItem(e.id);
  }
</script>

{#snippet row(e: InboxEntry)}
  {@const Icon = ICONS[e.source] ?? Mail}
  <li class="rounded-sm px-2 py-1.5 hover:bg-ink-5">
    <button class="flex w-full items-start gap-2 text-left" aria-expanded={open === e.id} onclick={() => (open = open === e.id ? undefined : e.id)}>
      <Icon size={14} class="mt-0.5 shrink-0 text-ink-45" />
      <span class="min-w-0 flex-1">
        <span class="line-clamp-1 text-[13px]">{e.title}</span>
        <span class="line-clamp-1 text-[12px] text-ink-45">{outcome(e)}{why(e) ? ` · ${why(e)}` : ""} · {ago(e.at)}</span>
      </span>
    </button>
    {#if open === e.id}
      {#if e.body}<p class="m-0 mt-1 ml-[22px] max-h-40 overflow-y-auto text-[12px] whitespace-pre-wrap text-ink-45">{e.body}</p>{/if}
      <div class="mt-1 ml-[22px] flex flex-wrap items-center gap-1">
        <button class="h-6 rounded-sm bg-ink-5 px-2 text-[12px] transition-colors hover:bg-ink-10 disabled:opacity-50" disabled={told.has(e.id)} onclick={() => void tell(e)}>{told.has(e.id) ? "Told General" : "Tell me about this"}</button>
        {#if e.target && !e.target.startsWith("task:")}<button class="h-6 rounded-sm bg-ink-5 px-2 text-[12px] transition-colors hover:bg-ink-10" onclick={() => go(e)}>Open where it went</button>{/if}
        {#if e.link}<a class="grid size-6 place-items-center rounded-sm text-ink-45 hover:bg-ink-10 hover:text-ink" href={e.link} target="_blank" rel="noopener" aria-label="Open the original" title="Open the original"><ExternalLink size={13} /></a>{/if}
      </div>
    {/if}
  </li>
{/snippet}

{#if !items}
  <p class="m-0 px-2 py-3 text-[13px] text-ink-45">Loading…</p>
{:else if !items.length}
  <p class="m-0 px-2 py-3 text-[13px] text-ink-45">Mail and messages show here once they come in.</p>
{:else}
  <div class="max-h-[60vh] overflow-y-auto">
    <h3 class="m-0 px-2 pt-1 pb-1 text-[12px] font-medium text-ink-45">Important · {important.length}</h3>
    {#if important.length}
      <ul class="m-0 list-none p-0">{#each important as e (e.id)}{@render row(e)}{/each}</ul>
    {:else}
      <p class="m-0 px-2 pb-1 text-[13px] text-ink-45">Nothing needed acting on.</p>
    {/if}
    <button class="mt-1 flex w-full items-center gap-1 px-2 py-1 text-left text-[12px] font-medium text-ink-45 hover:text-ink" aria-expanded={showSetAside} onclick={() => (showSetAside = !showSetAside)}>
      <ChevronRight size={12} class="transition-transform {showSetAside ? 'rotate-90' : ''}" /> Not important · {setAside.length}
    </button>
    {#if showSetAside}<ul class="m-0 list-none p-0">{#each setAside as e (e.id)}{@render row(e)}{/each}</ul>{/if}
  </div>
{/if}
