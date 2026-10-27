<script lang="ts" module>
  import type { IconName } from "../icons";

  export type Section = "appearance" | "usage" | "shortcuts" | "account" | "snapshot" | "modules" | "connectors" | "automations" | "projects" | "context" | "agents" | "spend";
  export const SECTIONS: readonly { id: Section; label: string; icon: IconName }[] = [
    { id: "appearance", label: "Appearance", icon: "sun" },
    { id: "usage", label: "Usage rings", icon: "zap" },
    { id: "shortcuts", label: "Shortcuts", icon: "key" },
    { id: "account", label: "Account", icon: "user" },
    { id: "snapshot", label: "Snapshot", icon: "archive" },
  ];
  /** What the dashboard used to be: pages about the daemon itself, each a section here. */
  export const PAGES: readonly { id: Section; label: string; icon: IconName }[] = [
    { id: "modules", label: "Modules", icon: "zap" },
    { id: "connectors", label: "Connectors", icon: "link" },
    { id: "automations", label: "Routines", icon: "clock" },
    { id: "projects", label: "Projects", icon: "folder" },
    { id: "context", label: "Context", icon: "book" },
    { id: "agents", label: "Agents", icon: "users" },
    { id: "spend", label: "Spend", icon: "hourglass" },
  ];
  export const SHORTCUTS: { keys: string; what: string }[] = [
    { keys: "⌘K", what: "search everything: views, agents, tasks, threads, settings" },
    { keys: "⌘⇧,", what: "settings" },
    { keys: "⌘1 / ⌘2 / ⌘3", what: "chat / board / threads" },
    { keys: "⌘.", what: "what happened: the bell" },
    { keys: "⌘F", what: "find in the open conversation" },
    { keys: "⌃L", what: "focus the message box" },
    { keys: "⌃N", what: "a new thread on its own" },
    { keys: "⌃Tab / ⌃⇧Tab", what: "next / previous thread in the threads view" },
    { keys: "/", what: "at the start of a message: a slash command (skills, plugins, built-ins)" },
    { keys: "⇧click", what: "open a thread in the right pane" },
    { keys: "right click · two-finger swipe left", what: "on a message: reply to it" },
  ];
</script>

<script lang="ts">
  import { PALETTES, type Palette, type ThemeMode } from "@desk/core";
  import { api } from "../api";
  import { auth } from "../auth.svelte";
  import { desk } from "../desk.svelte";
  import { prefs } from "../prefs.svelte";
  import { theme } from "../theme.svelte";
  import Icon from "../ui/Icon.svelte";
  import Sheet from "../ui/Sheet.svelte";
  import Connectors from "./Connectors.svelte";
  import Context from "./Context.svelte";
  import Modules from "./Modules.svelte";
  import Projects from "./Projects.svelte";
  import Routines from "./Routines.svelte";
  import Spend from "./Spend.svelte";
  import Staff from "./Staff.svelte";

  /**
   * The settings sheet: sections on the left, a search that filters every row, the rows on the right — how this
   * client looks, which rings it shows, the keys, the account, the snapshot — and under "pai" the pages about the
   * daemon itself: its modules, connectors, routines, projects, context, staff and spend.
   */
  let { section: initial = "appearance", onclose, onsection }: { section?: Section; onclose: () => void; onsection: (s: Section) => void } = $props();
  // svelte-ignore state_referenced_locally
  let section = $state<Section>(initial);
  $effect(() => void (section = initial));
  let query = $state("");
  let sheet = $state<Sheet>();
  const MODES: { value: ThemeMode; label: string; icon: IconName }[] = [
    { value: "system", label: "System", icon: "monitor" },
    { value: "light", label: "Light", icon: "sun" },
    { value: "dark", label: "Dark", icon: "moon" },
  ];
  const isPage = (s: Section) => PAGES.some((p) => p.id === s);

  interface Row {
    readonly section: Section;
    readonly id: string;
    readonly icon: IconName;
    readonly title: string;
    readonly hint?: string;
    readonly keywords: string;
    readonly stack?: boolean;
  }
  const rows: Row[] = [
    { section: "appearance", id: "mode", icon: "sun", title: "Mode", hint: "follows the system unless you pick one", keywords: "theme light dark system" },
    { section: "appearance", id: "light", icon: "sun", title: "Light theme", hint: "picking one switches to light", keywords: `theme ${PALETTES.filter((t) => t.kind === "light").map((t) => t.name).join(" ")}`, stack: true },
    { section: "appearance", id: "dark", icon: "moon", title: "Dark theme", hint: "picking one switches to dark", keywords: `theme ${PALETTES.filter((t) => t.kind === "dark").map((t) => t.name).join(" ")}`, stack: true },
    { section: "usage", id: "rings", icon: "zap", title: "Rings in the status bar", hint: "one ring per Claude limit window; hover a ring for the details", keywords: "quota limit session weekly fable opus sonnet", stack: true },
    ...SHORTCUTS.map((s): Row => ({ section: "shortcuts", id: `key:${s.keys}`, icon: "key", title: s.keys, hint: s.what, keywords: "keyboard shortcut keybinding" })),
    { section: "account", id: "who", icon: "user", title: "Signed in", hint: "the desk account shared with keep and people, or a token link", keywords: "sign out account clerk" },
    { section: "account", id: "daemon", icon: "link", title: "Daemon", hint: "the pai this page talks to", keywords: "address url host box" },
    { section: "snapshot", id: "export", icon: "download", title: "Export", hint: "memory, staff with their notes, open tasks, decisions, routines, project contexts — one markdown file", keywords: "backup save state" },
    { section: "snapshot", id: "import", icon: "enter", title: "Import", hint: "a snapshot handed to pai as a prompt: it creates the missing agents and tasks, writes their notes, merges the memory", keywords: "restore load state" },
  ];
  const visible = $derived(query.trim() ? rows.filter((r) => `${r.title} ${r.hint ?? ""} ${r.keywords}`.toLowerCase().includes(query.trim().toLowerCase())) : rows.filter((r) => r.section === section));

  function pick(next: Section) {
    section = next;
    query = "";
    onsection(next);
  }

  let exportNote = $state("");
  let importNote = $state("");
  let picker = $state<HTMLInputElement>();
  async function exportSnapshot() {
    try {
      const { text } = await api.snapshot();
      const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `pai-snapshot-${new Date().toISOString().slice(0, 10)}.md`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      exportNote = `${Math.round(text.length / 1000)}k characters`;
    } catch (error) {
      exportNote = (error as Error).message;
    }
  }
  async function importSnapshot() {
    const file = picker?.files?.[0];
    if (picker) picker.value = "";
    if (!file) return;
    importNote = "handing it to pai…";
    const result = await api.importSnapshot(await file.text());
    importNote = result.error ?? "pai is rebuilding from it; watch General";
  }
</script>

{#snippet swatch(p: Palette, on: boolean, choose: () => void)}
  {@const [bg, panel, line, ink, accent] = p.swatch}
  <button class="swatch" class:on title={p.name} onclick={choose} style="--sw-bg:{bg};--sw-line:{line}">
    <span class="sw-preview">
      <span class="sw-bar" style="background:{panel}"></span>
      <span class="sw-code">{#each [ink, accent, ink, accent, ink] as color, i (i)}<span class="sw-line" style="background:{color};width:{[46, 70, 58, 80, 40][i]}%;opacity:{i % 2 ? 0.9 : 0.35}"></span>{/each}</span>
    </span>
    <span class="sw-name">{p.name}</span>
  </button>
{/snippet}

{#snippet control(r: Row)}
  {#if r.id === "mode"}
    <div class="segmented">{#each MODES as m (m.value)}<button class="seg" class:on={theme.choice.mode === m.value} onclick={() => theme.choose({ mode: m.value })}><Icon name={m.icon} size={14} /><span>{m.label}</span></button>{/each}</div>
  {:else if r.id === "light" || r.id === "dark"}
    {@const kind = r.id}
    <div class="swatches">{#each PALETTES.filter((t) => t.kind === kind) as p (p.id)}{@render swatch(p, theme.choice[kind] === p.id, () => theme.choose({ [kind]: p.id, mode: kind }))}{/each}</div>
  {:else if r.id === "rings"}
    <div class="checks">
      {#each desk.usage?.windows ?? [] as w (w.name)}
        <label class="check"><input type="checkbox" checked={!prefs.hiddenRings.includes(w.name)} onchange={(e) => prefs.toggleRing(w.name, e.currentTarget.checked)} /><span>{w.name} · {w.percent}%</span></label>
      {:else}
        <span class="dim">{desk.usage?.error ?? "no windows reported yet"}</span>
      {/each}
    </div>
  {:else if r.id === "who"}
    <button class="btn" onclick={() => auth.signOut()}><Icon name="power" size={13} /><span>Sign out</span></button>
  {:else if r.id === "daemon"}
    <span class="dim kbd">{desk.hostname || location.host}</span>
  {:else if r.id === "export"}
    <span class="row-inline"><span class="dim">{exportNote}</span><button class="btn" onclick={exportSnapshot}><Icon name="download" size={12} />Export</button></span>
  {:else if r.id === "import"}
    <span class="row-inline"><span class="dim">{importNote}</span><button class="btn" onclick={() => picker?.click()}><Icon name="enter" size={12} />Import</button><input type="file" accept=".md,.txt,.json,text/*" hidden bind:this={picker} onchange={importSnapshot} /></span>
  {:else}
    <span></span>
  {/if}
{/snippet}

<Sheet bind:this={sheet} class="wide settings" {onclose}>
  <div class="sheet-body">
    <div class="settings-layout">
      <aside class="settings-side">
        <div class="settings-search-box"><Icon name="zap" size={13} /><input class="settings-search" placeholder="Search settings…" spellcheck="false" aria-label="Search settings" bind:value={query} /></div>
        <nav class="settings-nav">
          {#each SECTIONS as s (s.id)}<button class="dash-link" class:on={!query && section === s.id} onclick={() => pick(s.id)}><Icon name={s.icon} size={14} /><span>{s.label}</span></button>{/each}
          <h3 class="section-title">pai</h3>
          {#each PAGES as s (s.id)}<button class="dash-link" class:on={!query && section === s.id} onclick={() => pick(s.id)}><Icon name={s.icon} size={14} /><span>{s.label}</span></button>{/each}
        </nav>
      </aside>
      <div class="settings-main">
        <header class="sheet-head"><Icon name="settings" size={14} /><h2>Settings</h2><span class="grow"></span><span class="dim kbd">⌘⇧,</span><button class="iconbtn" title="close (esc)" aria-label="Close" onclick={() => sheet?.close()}><Icon name="x" size={14} /></button></header>
        <div class="settings-body" class:page={!query && isPage(section)}>
          {#if !query && isPage(section)}
            <div class="dash-body" class:full={section === "agents"}>
              {#if section === "modules"}<Modules />{:else if section === "connectors"}<Connectors />{:else if section === "automations"}<Routines />{:else if section === "projects"}<Projects />{:else if section === "context"}<Context />{:else if section === "agents"}<Staff />{:else if section === "spend"}<Spend />{/if}
            </div>
          {:else}
            {#each visible as r, i (r.id)}
              {#if query && r.section !== visible[i - 1]?.section}<h3 class="section-title">{SECTIONS.find((s) => s.id === r.section)?.label ?? r.section}</h3>{/if}
              <div class="setting" class:stack={r.stack}>
                <Icon name={r.icon} size={15} />
                <div class="setting-text"><span class="setting-title">{r.title}</span>{#if r.hint}<span class="dim">{r.hint}</span>{/if}</div>
                {#if r.stack}<span></span>{@render control(r)}{:else}{@render control(r)}{/if}
              </div>
            {:else}
              <p class="hint">nothing matches</p>
            {/each}
          {/if}
        </div>
      </div>
    </div>
  </div>
</Sheet>
