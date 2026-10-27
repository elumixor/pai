<script lang="ts">
  import { PALETTES } from "@desk/core";
  import { api } from "../api";
  import { desk, PAI } from "../desk.svelte";
  import Home from "../home/Home.svelte";
  import { agentIcon, TASK_ICON } from "../home/tree";
  import { fillTaskPills, referencePills } from "../markdown";
  import { conversions, fillMoney, moneyRates } from "../money";
  import { current, navigate, type Route } from "../router.svelte";
  import Settings, { PAGES, SECTIONS, type Section, SHORTCUTS } from "../settings/Settings.svelte";
  import { theme } from "../theme.svelte";
  import ThreadsView from "../threads/ThreadsView.svelte";
  import type { LogMessage, TaskStatus } from "../types";
  import BodyPeek from "../ui/BodyPeek.svelte";
  import Menus from "../ui/Menus.svelte";
  import { bodyPeek } from "../ui/peek.svelte";
  import Progress from "../ui/Progress.svelte";
  import Prompt from "../ui/Prompt.svelte";
  import { installTooltips } from "../ui/tooltip";
  import Nav from "./Nav.svelte";
  import { intents, openAgent } from "./open.svelte";
  import Palette, { type Command } from "./Palette.svelte";
  import StatusBar from "./StatusBar.svelte";

  /**
   * The page: the corner nav, then the room (the chat, the board, a task, a thread) or the threads side by side, the
   * settings sheet over whichever was open, ⌘K over everything. The keys are the old client's.
   */
  const route = $derived(current());
  /** What the settings sheet opens over: the view that was showing when it was asked for. */
  let behind = $state<Route>({ name: "home" });
  $effect(() => {
    if (route.name !== "settings") behind = route;
  });
  const view = $derived(route.name === "settings" ? behind : route);
  let palette = $state<{ filters: string[] } | null>(null);
  const SETTINGS_KEY = "⌘⇧,";

  $effect(() => {
    desk.start();
    const stopTips = installTooltips();
    document.body.classList.toggle("in-home", view.name !== "threads");
    return stopTips;
  });
  $effect(() => {
    document.body.classList.toggle("in-home", view.name !== "threads");
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
      if (kind === "task") return navigate({ name: "task", param: id });
      if (kind === "agent") return openAgent(id);
      if (kind === "ask") return openAgent(askOf(Number(id))?.agent ?? PAI);
      void messageRow(Number(id)).then((row) => row && openAgent(row.meta.agent ?? (row.from === "user" ? PAI : row.from), row.id));
    },
    (pill, kind, id) =>
      void bodyPeek.arm(`${kind}:${id}`, () => {
        if (kind === "task") {
          const t = desk.taskOf(Number(id));
          return t ? { glyph: t.status === "active" ? "spinner" : TASK_ICON[t.status], title: t.title, dim: `#${t.id}`, body: t.nextAction?.trim() || undefined, foot: [desk.nameOf(t.owner), t.due ? `due ${t.due}` : ""].filter(Boolean).join(" · ") } : undefined;
        }
        if (kind === "agent") {
          const a = desk.bySlug(id);
          if (!a) return undefined;
          const open = desk.tasks.filter((t) => t.owner === a.slug).length;
          return { glyph: agentIcon(a), title: a.name, body: a.brief.split("\n").find((l) => l.trim()), foot: `${open} open ${open === 1 ? "task" : "tasks"}` };
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

  async function commands(): Promise<Command[]> {
    const views: Command[] = [
      { id: "home", title: "Chat with pai", group: "view", icon: "message", hint: "the main chat", run: () => navigate("home") },
      { id: "board", title: "Board", group: "view", icon: "board", hint: "the agents' tasks, a kanban per agent", run: () => navigate("board") },
      { id: "threads", title: "Threads", group: "view", icon: "split", hint: "every conversation, two side by side", run: () => navigate("threads") },
      ...[...SECTIONS, ...PAGES].map<Command>((s) => ({ id: `settings:${s.id}`, title: PAGES.includes(s) ? s.label : `Settings: ${s.label}`, group: PAGES.includes(s) ? "view" : "settings", icon: s.icon, run: () => navigate({ name: "settings", param: s.id }) })),
    ];
    const actions: Command[] = [
      { id: "new-thread", title: "New thread", group: "action", icon: "plus", hint: "on its own: not pai, no project", run: () => void newThread() },
      { id: "refresh", title: "Refresh", group: "action", icon: "refresh", run: () => void desk.load() },
      { id: "notices", title: "What happened", group: "action", icon: "bell", run: () => window.dispatchEvent(new CustomEvent("pai:notices")) },
    ];
    const settings: Command[] = [
      ...(["system", "light", "dark"] as const).map<Command>((mode) => ({ id: `mode:${mode}`, title: `Mode: ${mode}`, group: "settings", icon: mode === "dark" ? "moon" : mode === "light" ? "sun" : "monitor", run: () => theme.choose({ mode }) })),
      ...PALETTES.map<Command>((p) => ({ id: `theme:${p.id}`, title: `Theme: ${p.name}`, group: "settings", icon: p.kind === "dark" ? "moon" : "sun", hint: p.kind, run: () => theme.choose(p.kind === "dark" ? { dark: p.id, mode: "dark" } : { light: p.id, mode: "light" }) })),
      ...SHORTCUTS.map<Command>((s) => ({ id: `key:${s.keys}`, title: `${s.keys} — ${s.what}`, group: "shortcut", icon: "key", run: () => navigate({ name: "settings", param: "shortcuts" }) })),
    ];
    const agents = desk.agents.filter((a) => a.status !== "closed").map<Command>((a) => ({ id: `agent:${a.slug}`, title: a.slug === PAI ? "General" : a.name, group: "agent", icon: agentIcon(a), hint: a.brief.split("\n")[0], run: () => openAgent(a.slug) }));
    const tasks = Object.values(desk.taskIndex)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .map<Command>((t) => ({ id: `task:${t.id}`, title: `#${t.id} ${t.title}`, group: "task", icon: TASK_ICON[t.status], hint: desk.nameOf(t.owner), run: () => navigate({ name: "task", param: String(t.id) }) }));
    const threads = desk.agents.flatMap((a) => (a.threads ?? []).map<Command>((t) => ({ id: `thread:${t.sessionId}`, title: t.title || t.shortId, group: "thread", icon: t.project ? "code" : "message", hint: t.project ?? desk.nameOf(a.slug), run: () => navigate({ name: "thread", param: t.sessionId }) })));
    const projects = desk.projects.map<Command>((p) => ({ id: `project:${p.slug}`, title: p.slug, group: "project", icon: p.kind === "context" ? "book" : "folder", hint: p.summary, run: () => navigate({ name: "project", param: p.slug }) }));
    return [...views, ...actions, ...settings, ...agents, ...tasks, ...threads, ...projects];
  }

  /** ⌃N: a thread on its own, opened on its first message — the main chat's box, switched to a new thread. */
  async function newThread() {
    intents.newThread = true;
    navigate("home");
  }

  function keydown(event: KeyboardEvent) {
    const meta = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (meta && key === "k") {
      event.preventDefault();
      palette = palette ? null : { filters: [] };
    } else if (meta && !event.shiftKey && (event.key === "1" || event.key === "2" || event.key === "3")) {
      event.preventDefault();
      navigate(event.key === "1" ? "home" : event.key === "2" ? "board" : "threads");
    } else if (meta && event.key === "." && !event.shiftKey) {
      event.preventDefault();
      window.dispatchEvent(new CustomEvent("pai:notices"));
    } else if (event.metaKey && event.shiftKey && (event.key === "," || event.key === "<")) {
      // ⌘, belongs to the browser; ⌘⇧, is pai's.
      event.preventDefault();
      navigate("settings");
    } else if (event.ctrlKey && !event.metaKey && !event.altKey && key === "l") {
      event.preventDefault();
      document.querySelector<HTMLElement>(".chat-compose .input, .tui-compose .input")?.focus();
    } else if (event.ctrlKey && !event.metaKey && !event.altKey && key === "n") {
      event.preventDefault();
      void newThread();
    }
  }

  function closeSettings() {
    navigate(behind);
  }
</script>

<svelte:window onkeydown={keydown} />

<Progress />
<Nav settingsKey={SETTINGS_KEY} />
{#if view.name === "threads"}
  <ThreadsView initial={view.param} />
  <StatusBar onpalette={() => (palette = { filters: [] })} />
{:else}
  <Home route={view} />
{/if}

{#if route.name === "settings"}
  <Settings section={(route.param as Section | undefined) ?? "appearance"} onclose={closeSettings} onsection={(s) => navigate({ name: "settings", param: s }, true)} />
{/if}
{#if palette}
  <Palette load={commands} filters={palette.filters} onclose={() => (palette = null)} />
{/if}
<Menus />
<Prompt />
<BodyPeek />
