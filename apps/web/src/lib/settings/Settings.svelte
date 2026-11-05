<script lang="ts" module>
  const SECTION_IDS = ["account", "appearance", "connectors", "automations", "context", "spend"] as const;
  export type Section = (typeof SECTION_IDS)[number];
  export const isSection = (id: string): id is Section => (SECTION_IDS as readonly string[]).includes(id);
</script>

<script lang="ts">
  import { PEOPLE_URL, type ThemeMode } from "@desk/core";
  import { SettingsDialog, type SettingsSection } from "@desk/core/settings";
  import { BookOpen, Clock, Contact, LogOut, Monitor, Moon, Palette as PaletteIcon, Plug, Sun, SunMoon, User, Wallet } from "lucide-svelte";
  import { auth } from "../auth.svelte";
  import { theme } from "../theme.svelte";
  import ThemesSheet from "./themes/ThemesSheet.svelte";
  import Connectors from "./Connectors.svelte";
  import Context from "./Context.svelte";
  import Routines from "./Routines.svelte";
  import SettingsBlock from "./SettingsBlock.svelte";
  import Spend from "./Spend.svelte";

  /**
   * The suite's settings dialog (`@desk/core/settings`, Keep's too): the account, how this client looks, then the
   * pages about the daemon itself: its connectors, routines, context and spend.
   */
  let { open = $bindable(false), active = $bindable<Section>("account"), onclose }: { open?: boolean; active?: Section; onclose?: () => void } = $props();

  const SECTIONS: SettingsSection<Section>[] = [
    { id: "account", label: "Account", icon: User, keywords: "sign out daemon host box clerk" },
    { id: "appearance", label: "Appearance", icon: PaletteIcon, keywords: "theme themes dark light mode palette editor colors fonts" },
    { id: "connectors", label: "Connectors", icon: Plug, keywords: "modules capabilities telegram email gmail linkedin whatsapp browser signed in" },
    { id: "automations", label: "Routines", icon: Clock, keywords: "automations cron events triggers" },
    { id: "context", label: "Context", icon: BookOpen, keywords: "instructions memories skills tools prompt vim" },
    { id: "spend", label: "Spend", icon: Wallet, keywords: "cost money tokens usage price" },
  ];
  const MODES: { value: ThemeMode; label: string; icon: typeof Sun }[] = [
    { value: "light", label: "Light", icon: Sun },
    { value: "dark", label: "Dark", icon: Moon },
    { value: "system", label: "System", icon: Monitor },
  ];
  let themesOpen = $state(false);
  const iconButton = "grid size-8 shrink-0 place-items-center rounded-sm text-ink-45 transition-colors hover:bg-ink-5 hover:text-ink";

</script>

<SettingsDialog sections={SECTIONS} bind:open bind:active {onclose}>
  {#snippet section(entry)}
    {#if entry.id === "appearance"}
      <div class="flex items-center gap-3 pr-8 max-md:pr-0">
        <SunMoon size={18} class="shrink-0 text-ink-45" />
        <span class="min-w-0 flex-1 truncate text-[14px]">Appearance</span>
        <button type="button" class="inline-flex h-8 items-center gap-2 rounded-sm px-3 text-[13px] transition-colors hover:bg-ink-5 [&>svg]:text-ink-45" aria-label="Themes" onclick={() => (themesOpen = true)}><PaletteIcon size={16} /><span class="max-sm:hidden">Themes</span></button>
        <div class="flex gap-1" role="radiogroup" aria-label="Mode">
          {#each MODES as m (m.value)}
            {@const on = theme.choice.mode === m.value}
            <button role="radio" aria-checked={on} aria-label={m.label} title={m.label} class="grid size-8 place-items-center rounded-sm transition-colors {on ? 'bg-accent text-surface' : 'text-ink-45 hover:bg-ink-5 hover:text-ink'}" onclick={() => theme.choose({ mode: m.value })}><m.icon size={16} /></button>
          {/each}
        </div>
      </div>
      {#if themesOpen}<ThemesSheet onclose={() => (themesOpen = false)} />{/if}
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
