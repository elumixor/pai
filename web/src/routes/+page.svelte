<script lang="ts">
  import { onMount } from "svelte";

  interface Snapshot {
    ts: number;
    projects: { slug: string; summary: string }[];
    sessions: { shortId: string; kind: string; project?: string; state: string; title: string; queued: number; waiting: boolean; costUsd: number; turns: number; lastTool: string }[];
    recent: { shortId: string; kind: string; project: string | null; title: string; state: string; lastResult: string; lastActivity: number; costUsd: number }[];
    events: { ts: number; kind: string; project?: string; sessionId?: string; payload: Record<string, any> }[];
  }

  let snapshot = $state<Snapshot | undefined>(undefined);
  let error = $state("");
  let fetchedAt = $state(0);
  let key = "";

  const age = $derived(snapshot ? Math.round((fetchedAt - snapshot.ts) / 1000) : 0);
  const stale = $derived(age > 180);

  async function load() {
    try {
      const res = await fetch(`/api/state?k=${encodeURIComponent(key)}`, { cache: "no-store" });
      if (res.status === 401) {
        // A stale key would keep failing forever, so forget it and wait for a fresh link.
        localStorage.removeItem("pai-key");
        key = "";
        error = "wrong or missing key — open the link with #k=<secret>";
        return;
      }
      snapshot = (await res.json()) as Snapshot;
      fetchedAt = Date.now();
      error = "";
    } catch (e) {
      error = (e as Error).message;
    }
  }

  onMount(() => {
    // The key arrives once in the URL fragment (never sent to the server as part
    // of the document request) and is remembered so the page can be bookmarked.
    const fromHash = /(?:^|[#&])k=([^&]+)/.exec(location.hash)?.[1];
    if (fromHash) {
      key = decodeURIComponent(fromHash);
      localStorage.setItem("pai-key", key);
      history.replaceState(null, "", location.pathname);
    } else {
      key = localStorage.getItem("pai-key") ?? "";
    }

    void load();
    // Only poll while the tab is actually being looked at.
    const timer = setInterval(() => document.visibilityState === "visible" && load(), 4000);
    return () => clearInterval(timer);
  });

  // A link from Telegram points at a session via ?s=<shortId> — scroll to it once loaded.
  let scrolledTo = false;
  $effect(() => {
    if (!snapshot || scrolledTo) return;
    const target = new URLSearchParams(location.search).get("s");
    if (!target) return;
    const el = document.getElementById(`sess-${target}`);
    if (!el) return;
    scrolledTo = true;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("highlight");
  });

  function clock(ts: number) {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function summarize(e: Snapshot["events"][number]) {
    const p = e.payload ?? {};
    if (e.kind === "session.tool") return p.summary || p.name;
    if (e.kind === "session.question") return (p.questions as { question: string }[] | undefined)?.map((q) => q.question).join(" | ") ?? "";
    if (typeof p.text === "string") return p.text.replace(/\s+/g, " ").slice(0, 200);
    return "";
  }
</script>

<main>
  <header>
    <h1>pai</h1>
    {#if snapshot}
      <span class="age" class:stale>
        {stale ? "daemon not reporting" : `updated ${age}s ago`}
      </span>
    {/if}
  </header>

  {#if error}
    <p class="error">{error}</p>
  {/if}

  {#if !snapshot}
    <p class="muted">loading…</p>
  {:else}
    <section>
      <h2>sessions</h2>
      {#if snapshot.sessions.length === 0}
        <p class="muted">nothing running</p>
      {:else}
        <ul class="sessions">
          {#each snapshot.sessions as s (s.shortId)}
            <li id="sess-{s.shortId}">
              <span class="dot {s.waiting ? 'waiting' : s.state}"></span>
              <code>{s.shortId}</code>
              <strong>{s.title}</strong>
              <span class="state">{s.waiting ? "waiting" : s.state}{s.queued ? ` +${s.queued} queued` : ""} · {s.kind}{s.project ? ` ${s.project}` : ""} · ${s.costUsd.toFixed(2)}</span>
              <span class="title">{s.lastTool}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section>
      <h2>recent</h2>
      <ul class="recent">
        {#each snapshot.recent.slice(0, 8) as r (r.shortId)}
          <li id="sess-{r.shortId}">
            <code>{r.shortId}</code>
            <strong>{r.title}</strong>
            <span class="state">{r.state}{r.project ? ` · ${r.project}` : ""}</span>
            <span class="title">{r.lastResult?.slice(0, 120)}</span>
          </li>
        {/each}
      </ul>
    </section>

    <section>
      <h2>activity</h2>
      <ul class="events">
        {#each [...snapshot.events].reverse().slice(0, 60) as e, i (e.ts + "-" + i)}
          <li>
            <span class="time">{clock(e.ts)}</span>
            <code>{e.sessionId?.slice(0, 6) ?? ""}</code>
            <span class="kind">{e.kind.replace("session.", "")}</span>
            <span class="detail">{summarize(e)}</span>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
</main>

<style>
  :global(body) {
    margin: 0;
    background: #0b0d10;
    color: #d8dee9;
    font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  }

  main {
    max-width: 780px;
    margin: 0 auto;
    padding: 24px 16px 64px;
  }

  header {
    display: flex;
    align-items: baseline;
    gap: 12px;
    margin-bottom: 28px;
  }

  h1 {
    font-size: 18px;
    margin: 0;
    letter-spacing: 0.04em;
  }

  li.highlight {
    animation: highlight 2s ease-out;
  }

  @keyframes highlight {
    from {
      background: #3b4a5a;
    }
    to {
      background: transparent;
    }
  }

  h2 {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: #6b7684;
    margin: 28px 0 10px;
  }

  .age {
    font-size: 12px;
    color: #6b7684;
  }
  .age.stale {
    color: #e0a458;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  li {
    display: flex;
    gap: 10px;
    align-items: baseline;
    padding: 5px 0;
    border-bottom: 1px solid #171b21;
  }

  code {
    color: #7aa2f7;
  }
  strong {
    font-weight: 500;
    color: #e6edf3;
  }

  .state,
  .time,
  .kind {
    color: #6b7684;
    font-size: 12px;
    flex: none;
  }
  .kind {
    min-width: 82px;
  }
  .time {
    min-width: 62px;
  }

  .title,
  .detail {
    color: #8b96a5;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #3d4451;
    flex: none;
  }
  .dot.busy {
    background: #7aa2f7;
  }
  .dot.idle {
    background: #56b366;
  }
  .dot.dead {
    background: #3d4451;
  }
  .dot.waiting {
    background: #e0a458;
  }

  .muted {
    color: #6b7684;
  }
  .error {
    color: #e06c75;
  }
</style>
