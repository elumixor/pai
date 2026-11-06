<script lang="ts">
  import { Briefcase, Calendar, ExternalLink, Mail, MessageCircle, Send } from "lucide-svelte";
  import { api } from "../api";
  import { desk } from "../desk.svelte";
  import { ago } from "../format";
  import { navigate } from "../router.svelte";
  import type { InboxEntry } from "../stores/inbox.svelte";

  /** One thing that came in and what triage did with it; opening it reads its words from where they live. */
  let { e, onclose }: { e: InboxEntry; onclose: () => void } = $props();

  const ICONS: Record<string, typeof Mail> = { mail: Mail, telegram: Send, whatsapp: MessageCircle, linkedin: Briefcase, calendar: Calendar };
  const Icon = $derived(ICONS[e.source] ?? Mail);

  let open = $state(false);
  let text = $state<string | undefined>();
  let told = $state(false);

  const parts = $derived((e.target ?? "").split(/:(.*)/s));
  const where = $derived.by(() => {
    const [kind, id = ""] = parts;
    return kind === "main" ? "General" : kind === "agent" ? desk.nameOf(id) : kind === "thread" ? (desk.threadOf(id)?.title ?? "a thread") : kind === "task" ? `task #${id}` : "";
  });
  const outcome = $derived({ pending: "Deciding…", ignored: "Ignored", muted: "Muted", filed: where ? `Filed under ${where}` : "Filed", woke: `Woke ${where}`, told: "Told you", routed: `To ${where || "General"}`, failed: "Failed" }[e.action]);
  /** The model's confidence ("ignore 92% · hiring 80%") as words; anything else is already words. */
  const why = $derived.by(() => {
    const sure = /^\w+ (\d+)%/.exec(e.note ?? "");
    return sure ? `${sure[1]}% sure` : (e.note ?? "");
  });

  function toggle() {
    open = !open;
    if (open && text === undefined) void api.itemText(e.id).then((r) => (text = r.text), () => (text = e.body));
  }

  function go() {
    const [kind, id = ""] = parts;
    if (kind === "thread" && id) navigate({ name: "thread", param: id });
    else if (kind === "agent" && id) navigate({ name: "chat", param: id });
    else if (kind === "main") navigate("home");
    else return;
    onclose();
  }

  function tell() {
    told = true;
    void api.tellAboutItem(e.id);
  }
</script>

<li class="rounded-sm px-2 py-1.5 hover:bg-ink-5">
  <button class="flex w-full items-start gap-2 text-left" aria-expanded={open} onclick={toggle}>
    <Icon size={14} class="mt-0.5 shrink-0 text-ink-45" />
    <span class="min-w-0 flex-1">
      <span class="line-clamp-1 text-[13px] text-ink-70">{e.title}</span>
      <span class="line-clamp-1 text-[11px] text-ink-30">{outcome}{why ? ` · ${why}` : ""} · {ago(e.at)}</span>
    </span>
  </button>
  {#if open}
    {#if text === undefined}
      <p class="m-0 mt-1 ml-[22px] text-[12px] text-ink-30">Reading…</p>
    {:else if text}
      <p class="m-0 mt-1 ml-[22px] max-h-40 overflow-y-auto text-[12px] whitespace-pre-wrap text-ink-45">{text}</p>
    {:else}
      <p class="m-0 mt-1 ml-[22px] text-[12px] text-ink-30">The words are no longer there.</p>
    {/if}
    <div class="mt-1 ml-[22px] flex flex-wrap items-center gap-1">
      <button class="h-6 rounded-sm bg-ink-5 px-2 text-[12px] transition-colors hover:bg-ink-10 disabled:opacity-50" disabled={told} onclick={tell}>{told ? "Told General" : "Tell me about this"}</button>
      {#if e.target && !e.target.startsWith("task:")}<button class="h-6 rounded-sm bg-ink-5 px-2 text-[12px] transition-colors hover:bg-ink-10" onclick={go}>Open where it went</button>{/if}
      {#if e.link}<a class="grid size-6 place-items-center rounded-sm text-ink-45 hover:bg-ink-10 hover:text-ink" href={e.link} target="_blank" rel="noopener" aria-label="Open the original" title="Open the original"><ExternalLink size={13} /></a>{/if}
    </div>
  {/if}
</li>
