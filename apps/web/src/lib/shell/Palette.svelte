<script lang="ts" module>
  import type { IconName } from "../icons";

  export interface Command {
    readonly id: string;
    readonly title: string;
    readonly group: string;
    readonly icon?: IconName;
    readonly hint?: string;
    readonly run: () => void;
  }

  /** Subsequence match with a score: word starts and runs of consecutive hits count for more. */
  export function score(query: string, text: string): number {
    if (!query) return 1;
    const q = query.toLowerCase();
    const t = text.toLowerCase();
    if (t.includes(q)) return 100 + (t.startsWith(q) ? 50 : 0) - t.length / 100;
    let qi = 0;
    let total = 0;
    let streak = 0;
    for (let i = 0; i < t.length && qi < q.length; i++) {
      if (t[i] === q[qi]) {
        streak += 1;
        total += streak * 2 + (i === 0 || /[\s/._-]/.test(t[i - 1]!) ? 5 : 0);
        qi += 1;
      } else streak = 0;
    }
    return qi === q.length ? total - t.length / 100 : 0;
  }
</script>

<script lang="ts">
  import Icon from "../ui/Icon.svelte";
  import Sheet from "../ui/Sheet.svelte";

  /**
   * ⌘K: one box for everything — views, actions, settings, agents, tasks, threads. The list is what the caller hands
   * over when it opens, so it is always current; groups narrow it as pills in the bar.
   */
  let { load, filters: initial = [], onclose }: { load: () => Promise<Command[]>; filters?: string[]; onclose: () => void } = $props();

  const LIMIT = 40;
  const PLURAL: Record<string, string> = { thread: "threads", agent: "agents", task: "tasks", project: "projects", action: "actions", view: "views", settings: "settings", shortcut: "shortcuts" };
  let sheet = $state<Sheet>();
  let input = $state<HTMLInputElement>();
  let list = $state<HTMLDivElement>();
  let query = $state("");
  // svelte-ignore state_referenced_locally
  let filters = $state<string[]>([...initial]);
  let commands = $state<Command[] | undefined>();
  let cursor = $state(0);

  $effect(() => void load().then((loaded) => (commands = loaded)));
  $effect(() => input?.focus());

  const hints = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q || !commands) return [];
    return [...new Set(commands.map((c) => c.group))].filter((g) => !filters.includes(g) && (g.startsWith(q) || (PLURAL[g] ?? "").startsWith(q)));
  });
  const shown = $derived(
    (commands ?? [])
      .filter((c) => !filters.length || filters.includes(c.group))
      .map((command) => ({ command, score: score(query.trim(), `${command.group} ${command.title}`) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, LIMIT)
      .map((entry) => entry.command),
  );
  $effect(() => {
    void query;
    void filters.length;
    cursor = 0;
  });
  $effect(() => list?.children[cursor]?.scrollIntoView({ block: "nearest" }));

  const placeholder = $derived(filters.length ? `Search ${filters.map((g) => PLURAL[g] ?? g).join(", ")}…` : "Search views, agents, tasks, threads, settings…");

  function addFilter(group: string) {
    filters = [...filters, group];
    query = "";
    input?.focus();
  }
  function dropFilter(group: string) {
    filters = filters.filter((g) => g !== group);
    input?.focus();
  }
  function run(command: Command | undefined) {
    if (!command) return;
    onclose();
    command.run();
  }
  const pick = () => (cursor < hints.length ? addFilter(hints[cursor]!) : run(shown[cursor - hints.length]));

  function keydown(event: KeyboardEvent) {
    if (event.key === "Backspace" && !query && filters.length) dropFilter(filters[filters.length - 1]!);
    else if (event.key === "ArrowDown") cursor = Math.min(hints.length + shown.length - 1, cursor + 1);
    else if (event.key === "ArrowUp") cursor = Math.max(0, cursor - 1);
    else if (event.key === "Enter") pick();
    else if (event.key === "Tab" && hints.length) addFilter(hints[cursor < hints.length ? cursor : 0]!);
    else return;
    event.preventDefault();
  }
</script>

<Sheet bind:this={sheet} class="palette" {onclose}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="palette-box" onkeydown={keydown}>
    <div class="palette-input">
      <Icon name="zap" size={14} />
      <span class="palette-pills">
        {#each filters as group (group)}
          <span class="palette-pill"><span>{PLURAL[group] ?? group}</span><button type="button" title="remove (⌫)" onclick={() => dropFilter(group)}><Icon name="x" size={10} /></button></span>
        {/each}
      </span>
      <input bind:this={input} bind:value={query} {placeholder} spellcheck="false" aria-label="Search" />
    </div>
    <div class="palette-list" bind:this={list}>
      {#each hints as group, index (group)}
        <button class="palette-row filter-row" class:active={index === cursor} onclick={() => addFilter(group)} onmousemove={() => (cursor = index)}>
          <Icon name="search" size={13} />
          <span class="label">Filter: <b>{PLURAL[group] ?? group}</b></span>
          <span class="dim ellipsis">only {PLURAL[group] ?? group}</span>
          <kbd class="key" title="Tab">⇥</kbd>
        </button>
      {/each}
      {#each shown as command, i (command.id)}
        <button class="palette-row" class:active={hints.length + i === cursor} onclick={() => run(command)} onmousemove={() => (cursor = hints.length + i)}>
          {#if command.icon}<Icon name={command.icon} size={13} />{:else}<span class="spacer"></span>{/if}
          <span class="label ellipsis">{command.title}</span>
          {#if command.hint}<span class="dim ellipsis">{command.hint}</span>{/if}
          {#if !filters.includes(command.group)}<span class="tag">{command.group}</span>{/if}
        </button>
      {/each}
      {#if !commands}
        <p class="hint">…</p>
      {:else if !hints.length && !shown.length}
        <p class="hint">nothing matches</p>
      {/if}
    </div>
  </div>
</Sheet>
