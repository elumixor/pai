<script lang="ts">
  import { PALETTES } from "@desk/core";
  import { CommandPalette, type PaletteItem } from "@desk/core/palette";
  import { ArrowUpRight, House, Keyboard, Monitor, Moon, PanelLeft, Plus, RefreshCw, Settings as SettingsIcon, Sun } from "lucide-svelte";
  import { fade } from "svelte/transition";
  import { api } from "../api";
  import { desk, PAI } from "../desk.svelte";
  import Home from "../home/Home.svelte";
  import { fillTaskPills, referencePills } from "../markdown";
  import { conversions, fillMoney, moneyRates } from "../money";
  import { current, navigate, type Route } from "../router.svelte";
  import Settings, { isSection, type Section } from "../settings/Settings.svelte";
  import Sidebar from "../sidebar/Sidebar.svelte";
  import { sidebar } from "../sidebar/state.svelte";
  import { agentIcon, ancestors, buildTree, threadIcon, threadTitle } from "../sidebar/tree";
  import { theme } from "../theme.svelte";
  import type { LogMessage, TaskStatus } from "../types";
  import BodyPeek from "../ui/BodyPeek.svelte";
  import Menus from "../ui/Menus.svelte";
  import { bodyPeek } from "../ui/peek.svelte";
  import Progress from "../ui/Progress.svelte";
  import { installTooltips } from "../ui/tooltip";
  import Keybindings from "./Keybindings.svelte";
  import { openAgent } from "./open.svelte";

  /**
   * The page, Keep's: the sidebar with General and the tree of threads, the open chat beside it, the settings dialog
   * and ⌘K over everything (both the suite's, from `@desk/core`). Projects, tasks and code live in Keep and Dev.
   */
  const route = $derived(current());
  /** What the settings dialog opens over: the place that was showing when it was asked for. */
  let behind = $state<Route>({ name: "home" });
  $effect(() => {
    if (route.name !== "settings") behind = route;
  });
  const view = $derived(route.name === "settings" ? behind : route);
  let settingsOpen = $state(false);
  let settingsSection = $state<Section>("account");
  $effect(() => {
    if (route.name !== "settings") return;
    settingsSection = route.param && isSection(route.param) ? route.param : "account";
    settingsOpen = true;
  });
  let paletteOpen = $state(false);
  let keybindingsOpen = $state(false);

  /** The row the open place is in the tree. */
  const active = $derived.by(() => {
    if (view.name === "home") return PAI;
    if (view.name === "chat") return view.param === PAI ? PAI : `agent:${view.param}`;
    if (view.name === "thread") return `thread:${desk.threadOf(view.param ?? "")?.sessionId ?? view.param}`;
    return undefined;
  });
  const roots = $derived(buildTree({ agents: desk.agents, sessions: desk.sessions, needs: desk.needs, open: active, pai: desk.paiSession?.sessionId }));
  // The open row shows: everything above it unfolds, once for each place opened.
  let revealed: string | undefined;
  $effect(() => {
    if (!active || active === PAI || active === revealed) return;
    const way = ancestors(roots, active);
    if (!way) return;
    revealed = active;
    sidebar.reveal(way);
  });

  $effect(() => {
    desk.start();
    document.body.classList.add("in-home");
    return installTooltips();
  });
  $effect(() => {
    document.title = desk.hostname ? `pai · ${desk.hostname}` : "pai";
  });

  // ---- references in messages: `#87` a task, `@dev` an agent, `?53` an ask, `^1904` a row; amounts of money --------

  const taskState = (status: TaskStatus) => (status === "done" || status === "dropped" ? "done" : status === "waiting_user" ? "warn" : "open");
  const rowCache = new Map<number, LogMessage | null>();
  const messageRow = async (id: number) => {
    if (!rowCache.has(id)) rowCache.set(id, await api.message(id).catch(() => null));
    return rowCache.get(id) ?? undefined;
  };
  const askOf = (id: number) => desk.needs.find((n) => n.kind === "ask" && n.askId === id);
  referencePills(
    (kind, id) => {
      if (kind === "task") {
        const t = desk.taskOf(Number(id));
        return t ? { kind, label: `#${t.id}`, state: taskState(t.status) } : undefined;
      }
      if (kind === "agent") {
        const a = desk.bySlug(id);
        return a ? { kind, label: a.name, state: a.status === "waiting" ? "warn" : a.status === "closed" ? "done" : "open" } : undefined;
      }
      if (kind === "ask") return askOf(Number(id)) ? { kind, label: `?${id}`, state: "warn" } : undefined;
      return /^\d+$/.test(id) ? { kind, label: `^${id}` } : undefined;
    },
    (kind, id) => {
      // A task has no page here: its owner's chat is where it is worked on.
      if (kind === "task") return openAgent(desk.taskOf(Number(id))?.owner ?? PAI);
      if (kind === "agent") return openAgent(id);
      if (kind === "ask") return openAgent(askOf(Number(id))?.agent ?? PAI);
      void messageRow(Number(id)).then((row) => row && openAgent(row.meta.agent ?? (row.from === "user" ? PAI : row.from), row.id));
    },
    (pill, kind, id) =>
      void bodyPeek.arm(`${kind}:${id}`, () => {
        if (kind === "task") {
          const t = desk.taskOf(Number(id));
          return t ? { glyph: t.status === "active" ? "spinner" : "circle", title: t.title, dim: `#${t.id}`, body: t.nextAction?.trim() || undefined, foot: [desk.nameOf(t.owner), t.status.replace("_", " "), t.due ? `due ${t.due}` : ""].filter(Boolean).join(" · ") } : undefined;
        }
        if (kind === "agent") {
          const a = desk.bySlug(id);
          if (!a) return undefined;
          return { glyph: "bot", title: a.name, body: a.brief.split("\n").find((l) => l.trim()), foot: `${a.kind} · ${a.status}` };
        }
        if (kind === "ask") {
          const need = askOf(Number(id));
          return need ? { glyph: "hand", title: need.question, body: need.options.map((o) => `- ${o}`).join("\n") || undefined, foot: desk.nameOf(need.agent ?? PAI) } : undefined;
        }
        return messageRow(Number(id)).then((row) => (row ? { title: desk.nameOf(row.from), body: row.body, foot: new Date(row.createdAt).toLocaleString() } : undefined));
      })(pill),
  );
  moneyRates(undefined, (node, amount) =>
    void bodyPeek.arm(`money:${amount.text}:${amount.currency}`, () => {
      const { lines, note } = conversions(amount);
      return { title: `${amount.text}${amount.per && !amount.text.includes(amount.per) ? amount.per : ""}`, body: lines.length ? lines.join("\n\n") : "no rates to convert with yet", foot: note };
    })(node),
  );
  $effect(() => {
    void api
      .rates()
      .then((r) => {
        moneyRates(r);
        // Rows drawn before the rates arrived carry their amounts as plain text; now they convert.
        for (const root of rendered()) fillMoney(root);
      })
      .catch(() => undefined);
  });
  // Rows drawn before the tasks arrived kept their `#id` as text; now it can be a pill.
  $effect(() => {
    if (desk.loaded) queueMicrotask(() => rendered().forEach((root) => fillTaskPills(root)));
  });

  /** Where rendered markdown lives: only there may text be turned into pills, never in Svelte's own text. */
  const rendered = () => [...document.querySelectorAll<HTMLElement>(".bubble, .card-body, .event-body, .q-body, .msg-body, .agent-note-body, .task-next-body, .task-notes, .draft-read, .peek-body")];

  // ---- ⌘K ------------------------------------------------------------------------------------------------------

  const openSettings = (section?: Section) => navigate(section ? { name: "settings", param: section } : "settings");
  const items = $derived.by((): PaletteItem[] => {
    const places: PaletteItem[] = [
      { key: "home", label: "General", group: "Go to", icon: House, hint: "pai, the orchestrator", run: () => navigate("home") },
      { key: "keep", label: "Keep", group: "Go to", icon: ArrowUpRight, hint: "projects, tasks, docs", run: () => window.open("https://keep.desk.atmagaming.com", "_blank", "noopener") },
      { key: "dev", label: "Dev", group: "Go to", icon: ArrowUpRight, hint: "repos, editor, terminals", run: () => window.open("https://dev.desk.atmagaming.com", "_blank", "noopener") },
    ];
    const actions: PaletteItem[] = [
      { key: "new-thread", label: "New thread", group: "Commands", icon: Plus, hint: "⌘N", run: () => navigate("new") },
      { key: "sidebar", label: sidebar.open ? "Hide the sidebar" : "Show the sidebar", group: "Commands", icon: PanelLeft, hint: "⌘\\", run: () => sidebar.toggle() },
      { key: "refresh", label: "Refresh", group: "Commands", icon: RefreshCw, run: () => void desk.load() },
      { key: "settings", label: "Settings", group: "Commands", icon: SettingsIcon, hint: "⌘⇧,", run: () => openSettings() },
      { key: "keybindings", label: "Keyboard shortcuts", group: "Commands", icon: Keyboard, hint: "⌘?", keywords: "keys keybindings hotkeys", run: () => (keybindingsOpen = true) },
      ...(["system", "light", "dark"] as const).map<PaletteItem>((mode) => ({ key: `mode:${mode}`, label: `Mode: ${mode}`, group: "Commands", icon: mode === "dark" ? Moon : mode === "light" ? Sun : Monitor, run: () => theme.choose({ mode }) })),
      ...PALETTES.map<PaletteItem>((p) => ({ key: `theme:${p.id}`, label: `Theme: ${p.name}`, group: "Commands", icon: p.kind === "dark" ? Moon : Sun, hint: p.kind, quiet: true, run: () => theme.choose(p.kind === "dark" ? { dark: p.id, mode: "dark" } : { light: p.id, mode: "light" }) })),
    ];
    const agents = desk.agents.filter((a) => a.slug !== PAI && a.status !== "closed").map<PaletteItem>((a) => ({ key: `agent:${a.slug}`, label: a.name, group: "Agents", icon: agentIcon(a), hint: a.brief.split("\n")[0], run: () => openAgent(a.slug) }));
    const threads = [...desk.sessions]
      .filter((s) => !s.agent && s.kind !== "main")
      .sort((x, y) => Number(y.lastActivity ?? 0) - Number(x.lastActivity ?? 0))
      .map<PaletteItem>((s, i) => ({ key: `thread:${s.sessionId}`, label: threadTitle(s), group: "Threads", icon: threadIcon(s), hint: s.project ?? s.shortId, keywords: s.shortId, quiet: i >= 8, run: () => navigate({ name: "thread", param: s.sessionId }) }));
    return [...places, ...actions, ...agents, ...threads];
  });

  function keydown(event: KeyboardEvent) {
    const key = event.key.toLowerCase();
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key === "\\") {
      event.preventDefault();
      sidebar.toggle();
    } else if (event.ctrlKey && !event.metaKey && !event.altKey && key === "l") {
      event.preventDefault();
      document.querySelector<HTMLElement>(".chat-compose .input")?.focus();
    } else if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && key === "n") {
      event.preventDefault();
      navigate("new");
    }
  }

  $effect(() => {
    void route;
    sidebar.settle();
  });
</script>

<svelte:window onkeydown={keydown} />

<Progress />
{#if sidebar.open}
  {#if sidebar.narrow}
    <div class="fixed inset-0 z-20 bg-[var(--backdrop)]" role="presentation" transition:fade={{ duration: 120 }} onclick={() => sidebar.toggle()}></div>
  {/if}
  <Sidebar {roots} {active} onsettings={() => openSettings()} />
{/if}
<Home route={view} {roots} {active} />

<Settings bind:open={settingsOpen} bind:active={settingsSection} onclose={() => route.name === "settings" && navigate(behind)} />
<Keybindings bind:open={keybindingsOpen} />
<CommandPalette {items} bind:open={paletteOpen} placeholder="Find a thread, an agent, or run a command…" />
<Menus />
<BodyPeek />
