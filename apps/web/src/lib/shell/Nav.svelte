<script lang="ts">
  import type { IconName } from "../icons";
  import { current, href, type RouteName } from "../router.svelte";
  import Icon from "../ui/Icon.svelte";
  import Bell from "./Bell.svelte";

  /**
   * The corner every view shares: the suite's app switcher where the brand sits, then the views — the chat, the board,
   * the threads, settings — and the bell with what happened and how much of it is new.
   */
  let { settingsKey }: { settingsKey: string } = $props();
  const ITEMS: readonly { name: RouteName; title: string; icon: IconName; active: readonly RouteName[] }[] = $derived([
    { name: "home", title: "Chat (⌘1)", icon: "message", active: ["home", "chat", "task", "thread", "project"] },
    { name: "board", title: "Board (⌘2)", icon: "board", active: ["board"] },
    { name: "threads", title: "Threads (⌘3)", icon: "split", active: ["threads"] },
    { name: "settings", title: `Settings (${settingsKey})`, icon: "settings", active: ["settings"] },
  ]);
  const route = $derived(current());
</script>

<nav class="nav" aria-label="pai">
  <desk-bar app="pai" class="nav-brand"></desk-bar>
  {#each ITEMS as item (item.name)}
    <a class="nav-item" class:on={item.active.includes(route.name)} href={href(item.name)} title={item.title} aria-label={item.title.replace(/ \(.*/, "")}><Icon name={item.icon} size={15} /></a>
  {/each}
  <Bell />
</nav>
