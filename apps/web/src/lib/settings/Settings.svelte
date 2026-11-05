<script lang="ts" module>
  const SECTION_IDS = ["account", "appearance", "shortcuts", "connectors", "automations", "context", "spend"] as const;
  export type Section = (typeof SECTION_IDS)[number];
  export const isSection = (id: string): id is Section => (SECTION_IDS as readonly string[]).includes(id);

  export const SHORTCUTS: [keys: string, what: string][] = [
    ["⌘K", "Find a thread, an agent, a setting, or run a command"],
    ["⌘⇧,", "Settings"],
    ["⌘\\", "Show or hide the sidebar"],
    ["⌃N", "A new thread"],
    ["⌃L", "Focus the message box"],
    ["⌘F", "Find in the open conversation"],
    ["j k · h l", "Move · fold, unfold, in the sidebar"],
    ["/", "At the start of a message: a slash command (skills, plugins, built-ins)"],
    ["Right click · two-finger swipe left", "On a message: reply to it"],
  ];
</script>

<script lang="ts">
  import { PALETTES, PEOPLE_URL, type Palette, type ThemeKind, type ThemeMode } from "@desk/core";
  import { SettingsDialog, type SettingsSection } from "@desk/core/settings";
  import { BookOpen, Clock, Contact, Keyboard, LogOut, Monitor, Moon, Palette as PaletteIcon, Plug, Sun, SunMoon, User, Wallet } from "lucide-svelte";
  import { auth } from "../auth.svelte";
  import { theme } from "../theme.svelte";
  import Connectors from "./Connectors.svelte";
  import Context from "./Context.svelte";
  import Routines from "./Routines.svelte";
  import SettingsBlock from "./SettingsBlock.svelte";
  import Spend from "./Spend.svelte";

  /**
   * The suite's settings dialog (`@desk/core/settings`, Keep's too): the account, how this client looks, the
   * keys, then the pages about the daemon itself: its connectors, routines, context and spend.
   */
  let { open = $bindable(false), active = $bindable<Section>("account"), onclose }: { open?: boolean; active?: Section; onclose?: () => void } = $props();

  const SECTIONS: SettingsSection<Section>[] = [
    { id: "account", label: "Account", icon: User, keywords: "sign out daemon host box clerk" },
    { id: "appearance", label: "Appearance", icon: PaletteIcon, keywords: "theme dark light mode palette" },
    { id: "shortcuts", label: "Keyboard", icon: Keyboard, keywords: "shortcuts keys keybinding" },
    { id: "connectors", label: "Connectors", icon: Plug, keywords: "modules capabilities telegram email gmail linkedin whatsapp browser signed in" },
    { id: "automations", label: "Routines", icon: Clock, keywords: "automations cron events triggers" },
    { id: "context", label: "Context", icon: BookOpen, keywords: "instructions memories skills tools prompt" },
    { id: "spend", label: "Spend", icon: Wallet, keywords: "cost money tokens usage price" },
  ];
  const MODES: { value: ThemeMode; label: string; icon: typeof Sun }[] = [
    { value: "light", label: "Light", icon: Sun },
    { value: "dark", label: "Dark", icon: Moon },
    { value: "system", label: "System", icon: Monitor },
  ];
  const KINDS: { kind: ThemeKind; label: string }[] = [
    { kind: "light", label: "Light theme" },
    { kind: "dark", label: "Dark theme" },
  ];
  const LINES = [46, 70, 58, 80, 40];
  const iconButton = "grid size-8 shrink-0 place-items-center rounded-sm text-ink-45 transition-colors hover:bg-ink-5 hover:text-ink";

</script>

{#snippet swatch(p: Palette, kind: ThemeKind)}
  {@const [bg, panel, line, ink, accent] = p.swatch}
  {@const on = theme.choice[kind] === p.id}
  <button
    role="radio"
    aria-checked={on}
    title={p.name}
    class="flex flex-col gap-1.5 rounded-md border-2 p-1 text-left text-[12px] transition-colors {on ? 'border-accent text-ink' : 'border-transparent text-ink-45 hover:border-line'}"
    onclick={() => theme.choose({ [kind]: p.id, mode: kind })}
  >
    <span class="flex h-14 overflow-hidden rounded-sm border" style="background:{bg};border-color:{line}">
      <span class="w-1/4" style="background:{panel}"></span>
      <span class="flex flex-1 flex-col justify-center gap-1 px-2">
        {#each LINES as width, i (i)}<span class="h-1 rounded-full" style="background:{i % 2 ? accent : ink};width:{width}%;opacity:{i % 2 ? 0.9 : 0.35}"></span>{/each}
      </span>
    </span>
    <span class="truncate px-0.5">{p.name}</span>
  </button>
{/snippet}

<SettingsDialog sections={SECTIONS} bind:open bind:active {onclose}>
  {#snippet section(entry)}
    {#if entry.id === "appearance"}
      <div class="space-y-4">
        <div class="flex items-center gap-3">
          <SunMoon size={18} class="shrink-0 text-ink-45" />
          <span class="flex-1 text-[14px]">Appearance</span>
          <div class="flex gap-1" role="radiogroup" aria-label="Mode">
            {#each MODES as m (m.value)}
              {@const on = theme.choice.mode === m.value}
              <button role="radio" aria-checked={on} aria-label={m.label} title={m.label} class="grid size-8 place-items-center rounded-sm transition-colors {on ? 'bg-accent text-surface' : 'text-ink-45 hover:bg-ink-5 hover:text-ink'}" onclick={() => theme.choose({ mode: m.value })}><m.icon size={16} /></button>
            {/each}
          </div>
        </div>
        {#each KINDS as k (k.kind)}
          <div class="space-y-2 pt-2">
            <p class="m-0 text-[13px] font-medium">{k.label}</p>
            <div class="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-2" role="radiogroup" aria-label={k.label}>
              {#each PALETTES.filter((p) => p.kind === k.kind) as p (p.id)}{@render swatch(p, k.kind)}{/each}
            </div>
          </div>
        {/each}
      </div>
    {:else if entry.id === "shortcuts"}
      <SettingsBlock title="Keyboard">
        <dl class="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
          {#each SHORTCUTS as [keys, what] (keys)}
            <dt><kbd class="rounded-xs bg-ink-5 px-1.5 py-0.5 font-mono text-[12px] text-ink-70">{keys}</kbd></dt>
            <dd class="m-0 text-ink-45">{what}</dd>
          {/each}
        </dl>
      </SettingsBlock>
    {:else if entry.id === "account"}
      <div class="flex items-center gap-4 pt-3 pr-8">
        {#if auth.user}
          {#if auth.user.avatar}
            <img src={auth.user.avatar} alt="" class="size-14 shrink-0 rounded-full" />
          {:else}
            <span class="grid size-14 shrink-0 place-items-center rounded-full bg-ink-10 text-[20px] font-semibold text-ink-70">{auth.user.fullName.slice(0, 1).toUpperCase()}</span>
          {/if}
          <div class="min-w-0">
            <p class="m-0 truncate text-[16px] font-medium">{auth.user.fullName}</p>
            {#if auth.user.email}<p class="m-0 truncate text-[13px] text-ink-45">{auth.user.email}</p>{/if}
          </div>
        {:else}
          <p class="m-0 min-w-0 flex-1 text-[13px] text-ink-45">Opened with a token link, so no person is signed in.</p>
        {/if}
        <div class="flex shrink-0 gap-1">
          {#if auth.user}<a class={iconButton} href={PEOPLE_URL} target="_blank" rel="noreferrer" aria-label="View in People" title="View in People"><Contact size={18} /></a>{/if}
          <button class={iconButton} aria-label="Sign out" title="Sign out" onclick={() => auth.signOut()}><LogOut size={18} /></button>
        </div>
      </div>
    {:else if entry.id === "connectors"}
      <SettingsBlock title="Connectors"><Connectors /></SettingsBlock>
    {:else if entry.id === "automations"}
      <SettingsBlock title="Routines"><Routines /></SettingsBlock>
    {:else if entry.id === "context"}
      <SettingsBlock title="Context"><Context /></SettingsBlock>
    {:else if entry.id === "spend"}
      <SettingsBlock title="Spend"><Spend /></SettingsBlock>
    {/if}
  {/snippet}
</SettingsDialog>
