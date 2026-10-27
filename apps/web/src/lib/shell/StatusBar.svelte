<script lang="ts">
  import { desk } from "../desk.svelte";
  import { ago, until } from "../format";
  import { prefs } from "../prefs.svelte";
  import Icon from "../ui/Icon.svelte";

  /** The bar under the threads view: the connection, the cost, one ring per usage window, the daemon. */
  let { onpalette }: { onpalette: () => void } = $props();
  const R = 5.5;
  const C = 2 * Math.PI * R;
  const data = $derived(desk.usage);
  const windows = $derived((data?.windows ?? []).filter((w) => !prefs.hiddenRings.includes(w.name)));
  const source = $derived(data?.via ? `read on ${data.via} ${data.fetchedAt ? ago(data.fetchedAt) : ""}` : "");
  const session = $derived(windows.find((w) => w.name === "Session"));
</script>

<footer class="statusbar">
  <div class="status-left">
    <span class="conn" class:online={desk.online} class:offline={!desk.online} title={desk.online ? "online" : "offline"}></span>
    {#if data}
      <span class="stat" title="what the sessions have cost, as the SDK reports it">${data.costUsd.toFixed(2)}</span>
      {#each windows as w (w.name)}
        {@const level = w.percent >= 90 ? "hot" : w.percent >= 70 ? "warm" : "cool"}
        <span class="stat" title={[w.name, `${w.percent}% of the limit used`, w.resetsAt ? `resets in ${until(w.resetsAt)}` : "", source].filter(Boolean).join("\n")}>
          <svg viewBox="0 0 14 14" class="status-ring {level}" aria-hidden="true">
            <circle cx="7" cy="7" r={R} class="track" />
            <circle cx="7" cy="7" r={R} class="fill" stroke-dasharray={C} stroke-dashoffset={C * (1 - Math.min(100, w.percent) / 100)} transform="rotate(-90 7 7)" />
          </svg>
          <span>{w.percent}%</span>
        </span>
      {/each}
      {#if session}<span class="stat dim" title="time left in the five-hour window">{until(session.resetsAt)}</span>{/if}
      {#if !data.windows.length}<span class="stat dim" title={data.error ?? ""}>no quota</span>{:else if data.error}<span class="stat dim" title={data.error}>stale</span>{/if}
    {:else}
      <span class="stat dim">offline</span>
    {/if}
  </div>
  <div class="status-right">
    <span class="stat dim" title="the daemon">{desk.hostname || location.host}</span>
    <button class="iconbtn slim" title="Search everything (⌘K)" aria-label="Search everything" onclick={onpalette}><Icon name="zap" size={13} /></button>
  </div>
</footer>
