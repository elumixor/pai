<script lang="ts">
  import { api } from "../api";
  import { desk } from "../desk.svelte";
  import { modelName } from "../format";
  import { live } from "../stores/live.svelte";
  import { recall, remember } from "../storage";
  import type { DiskSession, ProjectSummary, SessionSummary } from "../types";
  import { dialogs } from "../ui/dialogs.svelte";
  import Icon from "../ui/Icon.svelte";
  import ThreadPane from "./ThreadPane.svelte";

  /**
   * The threads, side by side: every project on the rail with its threads under it (terminal ones too), two panes to
   * open them in — a click opens the left one, ⇧click the right — and the split between them dragged to size. The
   * files, the editor and the terminals that used to sit here are the dev app's.
   */
  let { initial }: { initial?: string } = $props();
  const KEY = "pai.threads";
  const VISIBLE = 8;
  interface Layout {
    a?: string;
    b?: string;
    collapsed: string[];
    sizes: Record<string, number>;
  }
  let layout = $state<Layout>(recall<Layout>(KEY, { collapsed: [], sizes: {} }));
  let sessions = $state<SessionSummary[]>([]);
  let loaded = $state(false);
  let work = $state<HTMLDivElement>();
  const save = () => remember(KEY, JSON.stringify(layout));

  const fromDisk = (found: DiskSession): SessionSummary => ({ sessionId: found.sessionId, shortId: found.sessionId.slice(0, 6), kind: "claude", title: found.title, state: "detached", cwd: found.cwd, lastActivity: found.lastActivity });
  const activity = (s: SessionSummary) => (s.state === "busy" || s.state === "starting" || s.waiting ? Number.MAX_SAFE_INTEGER - 1 : s.lastActivity ? new Date(s.lastActivity).getTime() : 0);
  /** The project a session belongs to: the one it was started in, or the one whose directory holds its cwd. */
  const projectOf = (s: SessionSummary, catalog: readonly ProjectSummary[]) => s.project ?? catalog.find((p) => s.cwd === p.path || s.cwd?.startsWith(`${p.path}/`))?.slug ?? "workspace";
  const stateClass = (s: SessionSummary) => (s.waiting ? "waiting" : s.state === "busy" || s.state === "starting" ? "busy" : s.state === "idle" ? "idle" : "dead");

  /** Everything the daemon knows plus every conversation on disk under a project. */
  async function refresh() {
    const catalog = desk.projects;
    const [{ live: running, recent }, ...onDisk] = await Promise.all([api.sessions().catch(() => ({ live: [], recent: [] })), ...catalog.map((p) => api.threadsIn(p.path).catch(() => [] as DiskSession[]))]);
    const known = [...running, ...recent.filter((r) => !running.some((l) => l.sessionId === r.sessionId))];
    const seen = new Set(known.map((s) => s.sessionId));
    sessions = [...known, ...onDisk.flat().filter((f) => !seen.has(f.sessionId)).map(fromDisk)].sort((a, b) => activity(b) - activity(a));
    loaded = true;
  }
  $effect(() => {
    void desk.projects;
    void refresh();
  });
  $effect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return live.on((event) => {
      if (!["session.started", "session.resumed", "session.turn_end", "session.exit", "task.created", "session.question"].includes(event.kind)) return;
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 300);
    });
  });
  // `threads/<session>`: that thread, in the left pane unless it is open already.
  $effect(() => {
    if (initial && layout.a !== initial && layout.b !== initial) {
      layout.a = initial;
      save();
    }
  });

  const groups = $derived.by(() => {
    const out = new Map<string, SessionSummary[]>();
    for (const s of sessions) out.set(projectOf(s, desk.projects), [...(out.get(projectOf(s, desk.projects)) ?? []), s]);
    return [...new Set([...desk.projects.map((p) => p.slug), ...out.keys()])].sort((a, b) => a.localeCompare(b)).map((key) => ({ key, project: desk.projects.find((p) => p.slug === key), threads: out.get(key) ?? [] }));
  });
  const byId = (id?: string) => sessions.find((s) => s.sessionId === id || s.shortId === id);
  const paneA = $derived(byId(layout.a));
  const paneB = $derived(byId(layout.b));

  function open(s: SessionSummary, slot: "a" | "b") {
    const other = slot === "a" ? "b" : "a";
    if (layout[other] === s.sessionId) layout[other] = undefined;
    layout[slot] = s.sessionId;
    save();
  }
  function close(slot: "a" | "b") {
    layout[slot] = undefined;
    save();
  }
  function swap() {
    [layout.a, layout.b] = [layout.b, layout.a];
    save();
  }
  function fold(key: string) {
    layout.collapsed = layout.collapsed.includes(key) ? layout.collapsed.filter((k) => k !== key) : [...layout.collapsed, key];
    save();
  }
  /** Starts a thread straight away; it takes its name from the first message. */
  async function newThread(project?: string) {
    const result = await api.startThread("", [], project);
    if (result.data?.sessionId) {
      await refresh();
      layout.a = result.data.sessionId;
      save();
    }
  }
  async function addProject() {
    const answer = await dialogs.ask({
      title: "Add a project",
      description: "A project is a git checkout under ~/dev on the box. Paste the repository to clone — GitHub or anywhere git can reach.",
      fields: [
        { name: "url", label: "Repository", placeholder: "git@github.com:you/thing.git", required: true },
        { name: "name", label: "Directory", placeholder: "defaults to the repository's name" },
      ],
      submit: "Clone",
    });
    if (!answer?.url) return;
    const result = await api.addProject(answer.url, answer.name || undefined);
    if (!result.error) await desk.load();
  }

  /** The handles between the panes: each writes one size, remembered. */
  function resize(name: string, sign: number) {
    return (down: PointerEvent) => {
      const handle = down.currentTarget as HTMLElement;
      if (!work) return;
      down.preventDefault();
      handle.setPointerCapture(down.pointerId);
      handle.classList.add("active");
      const start = layout.sizes[name] ?? (name === "--w-rail" ? 260 : (work.clientWidth - 280) / 2);
      const origin = down.clientX;
      const move = (event: PointerEvent) => (layout.sizes = { ...layout.sizes, [name]: Math.max(180, start + (event.clientX - origin) * sign) });
      const up = () => {
        handle.classList.remove("active");
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        save();
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    };
  }
  const style = $derived(Object.entries({ "--w-second": 420, "--w-rail": 260, ...layout.sizes }).map(([k, v]) => `${k}: ${v}px`).join("; "));
</script>

<div class="work" class:b-empty={!paneB} class:has-a={Boolean(paneA)} bind:this={work} {style} data-testid="threads">
  <section class="panel thread-slot">
    {#if paneA}
      {#key paneA.sessionId}<ThreadPane session={paneA} onclose={() => close("a")} onswap={swap} />{/key}
    {:else}
      <div class="empty"><Icon name="message" size={24} /><p class="dim">Pick a thread on the right, or ⌘K.</p><button class="btn" onclick={() => newThread()}>New thread</button></div>
    {/if}
  </section>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="handle v second" onpointerdown={resize("--w-second", -1)}></div>
  <section class="panel thread-slot second">
    {#if paneB}{#key paneB.sessionId}<ThreadPane session={paneB} onclose={() => close("b")} onswap={swap} />{/key}{/if}
  </section>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="handle v" onpointerdown={resize("--w-rail", -1)}></div>
  <aside class="col col-rail">
    <div class="rail-scroll">
      {#if !loaded}<div class="skeleton skeleton-lines" aria-hidden="true">{#each [72, 54, 86, 40, 66] as w (w)}<span class="sk-line" style="--w: {w}%"></span>{/each}</div>{/if}
      {#each groups as g (g.key)}
        {@const collapsed = layout.collapsed.includes(g.key)}
        <section class="group">
          <header class="group-head" role="button" tabindex="0" title={g.threads.length ? "open the latest thread" : ""} onclick={() => g.threads[0] && open(g.threads[0], "a")} onkeydown={(e) => e.key === "Enter" && g.threads[0] && open(g.threads[0], "a")}>
            {#if g.project?.kind === "context"}<Icon name="book" size={12} />{/if}
            <span class="name">{g.key}</span>
            <span class="count">{g.threads.length || ""}</span>
            {#if g.project}<button class="iconbtn" title="new thread in {g.key}" aria-label="New thread in {g.key}" onclick={(e) => (e.stopPropagation(), void newThread(g.project!.slug))}><Icon name="plus" size={13} /></button>{/if}
            {#if g.project?.repo}<a class="iconbtn" href={g.project.repo} target="_blank" rel="noreferrer" title={g.project.repo} onclick={(e) => e.stopPropagation()}><Icon name="github" size={13} /></a>{/if}
            <button class="iconbtn chev" class:closed={collapsed} title={collapsed ? "expand" : "collapse"} aria-label={collapsed ? "Expand" : "Collapse"} onclick={(e) => (e.stopPropagation(), fold(g.key))}><Icon name="chevron" size={13} /></button>
          </header>
          {#if !collapsed}
            <div class="threads" class:long={g.threads.length > VISIBLE}>
              {#each g.threads as s (s.sessionId)}
                <button class="thread" class:open={s.sessionId === layout.a || s.sessionId === layout.b} data-session={s.sessionId} title="{s.title || s.shortId}&#10;{s.shortId}{s.model ? ` · ${modelName(s.model)}` : ''}&#10;click: open · shift+click: open on the right" onclick={(e) => open(s, e.shiftKey ? "b" : "a")}>
                  <span class="dot {stateClass(s)}"></span><span class="label">{s.title || s.shortId}</span>{#if s.kind === "claude"}<Icon name="terminal" size={11} />{/if}
                </button>
              {/each}
            </div>
          {/if}
        </section>
      {/each}
    </div>
    <button class="add-project" onclick={addProject}><Icon name="plus" size={14} /><span>Add project</span></button>
  </aside>
</div>
