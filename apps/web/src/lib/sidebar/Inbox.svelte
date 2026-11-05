<script lang="ts">
  import { type InboxGroup, type InboxItem, InboxList } from "@desk/core/inbox";
  import { Briefcase, Calendar, ExternalLink, FileText, Inbox as InboxIcon, Mail, MessageCircle, Send } from "lucide-svelte";
  import { desk } from "../desk.svelte";
  import Waiting from "./Waiting.svelte";
  import { ago, dayLabel, dayOf } from "../format";
  import { navigate } from "../router.svelte";
  import { type InboxEntry, inbox } from "../stores/inbox.svelte";

  /** Pai's inbox: what came in (mail, chats, Keep) and what Pai did with it; opening one goes where it was handled. */
  let { onclose }: { onclose: () => void } = $props();

  const FILTERS = [
    { value: "relevant", label: "Relevant" },
    { value: "all", label: "All" },
  ];
  const ICONS: Record<string, typeof Mail> = { mail: Mail, telegram: Send, whatsapp: MessageCircle, linkedin: Briefcase, calendar: Calendar, keep: FileText };

  type Row = InboxItem & { readonly e: InboxEntry };

  /** Where it went, as he would say it. */
  function outcome(e: InboxEntry) {
    const [kind, id = ""] = (e.target ?? "").split(/:(.*)/s);
    const where = kind === "main" ? "General" : kind === "agent" ? desk.nameOf(id) : kind === "thread" ? (desk.threadOf(id)?.title ?? "a thread") : kind === "task" ? `task #${id}` : "";
    switch (e.action) {
      case "pending":
        return "Deciding…";
      case "ignored":
        return "Ignored";
      case "muted":
        return "Muted";
      case "filed":
        return where ? `Filed under ${where}` : "Filed";
      case "woke":
        return `Woke ${where}`;
      case "told":
        return "Told you";
      case "routed":
        return `To ${where || "General"}`;
      case "failed":
        return "Failed";
    }
  }

  let filter = $state(inbox.filter);
  $effect(() => {
    if (filter !== inbox.filter) inbox.show(filter as "relevant" | "all");
  });

  const groups = $derived.by(() => {
    const out: (InboxGroup<Row> & { items: Row[] })[] = [];
    for (const e of inbox.items) {
      const key = dayOf(e.at);
      let group = out.at(-1);
      if (group?.key !== key) out.push((group = { key, title: dayLabel(e.at), items: [] }));
      const why = e.note ? ` — ${e.note}` : "";
      group.items.push({
        id: e.id,
        e,
        title: e.title,
        text: e.body.replace(/\s+/g, " ").trim() || undefined,
        meta: `${outcome(e)}${why} · ${ago(e.at)}`,
        unread: !e.readAt && e.action !== "ignored" && e.action !== "muted",
        quiet: e.action === "ignored" || e.action === "muted",
      });
    }
    return out;
  });

  /** Opens where Pai handled it: the thread, the agent's chat, General; else the thing itself. */
  function open(row: Row) {
    const { e } = row;
    void inbox.read([e.id]);
    const [kind, id = ""] = (e.target ?? "").split(/:(.*)/s);
    if (kind === "thread" && id) navigate({ name: "thread", param: id });
    else if (kind === "agent" && id) navigate({ name: "chat", param: id });
    else if (kind === "main") navigate("home");
    else if (e.link) window.open(e.link, "_blank", "noopener");
    else return;
    onclose();
  }
</script>

<Waiting {onclose} />
<InboxList
  {groups}
  unread={inbox.unread}
  filters={FILTERS}
  bind:filter
  onopen={open}
  onreadall={() => void inbox.read()}
  empty={filter === "relevant" ? "Nothing that needed Pai. All shows what it ignored too." : "Nothing came in yet."}
>
  {#snippet lead(row)}
    {@const Icon = ICONS[row.e.source] ?? InboxIcon}
    <Icon size={16} />
  {/snippet}
  {#snippet aside(row)}
    {#if row.e.link}
      <a class="grid size-6 place-items-center rounded-xs text-ink-30 hover:bg-ink-10 hover:text-ink" href={row.e.link} target="_blank" rel="noopener" aria-label="Open the original" title="Open the original"><ExternalLink size={14} /></a>
    {/if}
  {/snippet}
</InboxList>
