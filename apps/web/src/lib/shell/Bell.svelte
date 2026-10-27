<script lang="ts">
  import { api } from "../api";
  import { ago, firstLine } from "../format";
  import type { IconName } from "../icons";
  import { loadReads, markRead, readAt } from "../reads";
  import { live } from "../stores/live.svelte";
  import type { AuditEntry, LogMessage, TaskItem } from "../types";
  import Icon from "../ui/Icon.svelte";
  import { openNotice } from "./open.svelte";

  /**
   * The bell in the corner: what was done and what is asked while he was not looking. An action taken out in the
   * world (the audit trail), a request to him (an ask), a task started or finished, a sub-agent started or closed —
   * and nothing else. Opening it lists them newest first; a press opens the chat or the task it is about.
   */
  const SHOWN = 40;
  /** The bell's own place in the daemon's read marks: the same notion every chat uses. */
  const BELL = "notices";
  const AGENT_EVENTS = new Set(["agent.spawned", "agent.closed"]);
  const TASK_DONE = new Set(["done", "dropped"]);
  const TOOL_ICONS: readonly (readonly [RegExp, IconName])[] = [
    [/gmail|mail/i, "mail"],
    [/telegram|linkedin|message|send|reply/i, "send"],
    [/calendar|event/i, "calendar"],
    [/browser|click|navigate|playwright/i, "globe"],
    [/^\$|bash|write|edit/i, "terminal"],
  ];

  interface Notice {
    readonly key: string;
    readonly at: number;
    readonly icon: IconName;
    readonly text: string;
    readonly who: string;
    readonly tip?: string;
    readonly open: { readonly agent?: string; readonly id?: number; readonly task?: number };
  }

  const nameOf = (slug: string | null | undefined) => (!slug || slug === "pai" ? "pai" : slug === "user" ? "you" : slug.replace(/^(routine|watcher):/, ""));
  const fromAudit = (e: AuditEntry): Notice => ({
    key: `audit:${e.toolUseId}`,
    at: e.ts,
    icon: e.ok === false ? "alert" : (TOOL_ICONS.find(([re]) => re.test(`${e.tool} ${e.summary}`))?.[1] ?? "zap"),
    text: e.summary.replace(/^mcp__[^_]+__/, "").replace(/^[a-z-]+:/, (s) => `${s} `),
    who: nameOf(e.agent),
    tip: e.result ?? undefined,
    open: { agent: e.agent ?? "pai" },
  });
  const fromMessage = (m: LogMessage): Notice | undefined => {
    if (m.kind === "ask") return { key: `m:${m.id}`, at: m.createdAt, icon: "hand", text: m.meta.headline || firstLine(m.body), who: m.meta.breadcrumb?.split(" › ").pop() ?? nameOf(m.from), tip: m.body, open: { agent: m.meta.agent ?? m.from, id: m.id } };
    if (m.kind === "event" && AGENT_EVENTS.has(m.meta.event ?? "")) return { key: `m:${m.id}`, at: m.createdAt, icon: m.meta.event === "agent.closed" ? "circleCheck" : "rocket", text: firstLine(m.body), who: nameOf(m.from), tip: m.body, open: { agent: m.meta.agent ?? m.to, id: m.id } };
    return undefined;
  };
  const fromTask = (t: TaskItem): Notice[] => {
    const started: Notice = { key: `task:${t.id}:new`, at: t.createdAt ?? 0, icon: "plus", text: `Task #${t.id}: ${t.title}`, who: nameOf(t.owner), tip: t.nextAction, open: { task: t.id } };
    if (!TASK_DONE.has(t.status)) return [started];
    return [{ key: `task:${t.id}:${t.status}`, at: t.updatedAt ?? t.createdAt ?? 0, icon: t.status === "done" ? "circleCheck" : "x", text: `Task #${t.id} ${t.status}: ${t.title}`, who: nameOf(t.owner), tip: t.notes || t.nextAction, open: { task: t.id } }, started];
  };

  let audit = $state<Notice[]>([]);
  let fromLog = $state<Record<number, Notice>>({});
  let fromTasks = $state<Record<number, Notice[]>>({});
  let open = $state(false);
  let mark = $state(0);
  let openedMark = $state(0);
  let slot = $state<HTMLSpanElement>();

  const rows = $derived(
    [...audit, ...Object.values(fromLog), ...Object.values(fromTasks).flat()]
      .filter((n) => n.at > 0)
      .sort((a, b) => b.at - a.at)
      .slice(0, SHOWN),
  );
  const unread = $derived(rows.filter((n) => n.at > mark).length);

  const loadAudit = () => api.audit(SHOWN).then((all) => (audit = all.map(fromAudit)));
  $effect(() => {
    void loadReads().then(() => (mark = readAt(BELL)));
    const quiet = (p: Promise<unknown>) => p.catch((error) => console.warn("[bell]", error));
    void quiet(loadAudit());
    void quiet(api.notices(["ask", "event"], SHOWN * 3).then((all) => (fromLog = Object.fromEntries(all.flatMap((m) => (fromMessage(m) ? [[m.id, fromMessage(m)!]] : []))))));
    void quiet(api.allTasks().then((all) => (fromTasks = Object.fromEntries(all.map((t) => [t.id, fromTask(t)])))));
    // An outward call settles after it is recorded: the trail is re-read once the turn is quiet.
    let auditTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = live.on((event) => {
      if (event.kind === "message.new") {
        const m = event.payload as unknown as LogMessage;
        const notice = fromMessage(m);
        if (notice) fromLog = { ...fromLog, [m.id]: notice };
      } else if (event.kind === "task.added" || event.kind === "task.updated") {
        const t = event.payload as unknown as TaskItem;
        if (typeof t.id === "number") fromTasks = { ...fromTasks, [t.id]: fromTask(t) };
      } else if (event.kind === "session.tool" || event.kind === "session.turn_end") {
        clearTimeout(auditTimer);
        auditTimer = setTimeout(() => void quiet(loadAudit()), 1500);
      }
    });
    const toggleKey = () => toggle();
    window.addEventListener("pai:notices", toggleKey);
    return () => {
      stop();
      window.removeEventListener("pai:notices", toggleKey);
    };
  });

  /** Opening it: everything on screen now has been seen; what comes while it is open is new until the next opening. */
  function toggle() {
    if (open) {
      open = false;
      return;
    }
    open = true;
    // The rows stay marked as new while the list is open; the count is against the new mark.
    openedMark = mark;
    const newest = rows[0]?.at ?? 0;
    if (newest > mark) {
      markRead(BELL, newest);
      mark = newest;
    }
  }

  function outside(event: PointerEvent) {
    if (open && slot && !slot.contains(event.target as Node)) open = false;
  }
</script>

<svelte:document onpointerdown={outside} onkeydown={(e) => e.key === "Escape" && (open = false)} />

<span class="nav-bell-slot" bind:this={slot}>
  <button class="nav-item nav-bell" class:on={open} class:has-news={unread > 0} title="What happened (⌘.)" aria-label="What happened" onclick={toggle}>
    <Icon name="bell" size={15} />
    {#if unread && !open}<span class="nav-count">{unread > 99 ? "99+" : unread}</span>{/if}
  </button>
  {#if open}
    <div class="notices">
      <div class="notices-head">What happened</div>
      <div class="notices-list">
        {#each rows as n (n.key)}
          <button class="notice-row" class:unread={n.at > openedMark} title={n.tip} onclick={() => ((open = false), openNotice(n.open))}>
            <Icon name={n.icon} size={12} />
            <span class="notice-body"><span class="notice-text">{n.text}</span><span class="notice-meta">{n.who} · {ago(n.at)}</span></span>
          </button>
        {:else}
          <p class="notices-empty">Nothing yet.</p>
        {/each}
      </div>
    </div>
  {/if}
</span>
