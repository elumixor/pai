<script lang="ts">
  import { desk } from "../desk.svelte";
  import { modelName, until } from "../format";
  import type { UsageWindow } from "../types";

  /**
   * The two discs in the box's foot: the session window, and the week — the model's own weekly limit when the model
   * has one, else the shared one. The percent inside the ring, the time to the reset beside it.
   */
  let { model }: { model?: string | null } = $props();
  const R = 6.5;
  const C = 2 * Math.PI * R;

  const discs = $derived.by(() => {
    const data = desk.usage ?? { windows: [], costUsd: 0, error: "the daemon is not reachable" };
    const session = data.windows.find((w) => w.name === "Session");
    const family = model ? modelName(model).split(" ")[0]!.toLowerCase() : "";
    const week = (family && data.windows.find((w) => w.name.toLowerCase().includes(family))) || data.windows.find((w) => w.name === "Weekly");
    const why = `${data.error ?? "no usage reported yet"}${data.needsLogin ? " — reconnect Claude at /claude/login" : ""}`;
    return [
      { w: session, title: session ? `${session.name}: ${session.percent}% used` : `Session: unavailable — ${why}` },
      { w: week, title: week ? `${week.name}: ${week.percent}% used` : `Weekly: unavailable — ${why}` },
    ];
  });
  const level = (w: UsageWindow | undefined) => (!w ? "none" : w.percent >= 90 ? "hot" : w.percent >= 70 ? "warm" : "cool");
</script>

<span class="rings">
  {#each discs as { w, title }, i (i)}
    <span class="ring-mini {level(w)}" title={w?.resetsAt ? `${title} · resets in ${until(w.resetsAt)}` : title}>
      <span class="disc">
        <svg viewBox="0 0 15 15" aria-hidden="true">
          <circle cx="7.5" cy="7.5" r={R} class="track" />
          {#if w}<circle cx="7.5" cy="7.5" r={R} class="fill" stroke-dasharray={C} stroke-dashoffset={C * (1 - Math.min(100, w.percent) / 100)} transform="rotate(-90 7.5 7.5)" />{/if}
        </svg>
        <span>{w ? String(w.percent) : "–"}</span>
      </span>
      <span>{w ? until(w.resetsAt) : "n/a"}</span>
    </span>
  {/each}
</span>
