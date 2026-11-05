<script lang="ts">
  import { api } from "../api";
  import { desk } from "../desk.svelte";
  import { modelName } from "../format";
  import type { UsageWindow } from "../types";

  /**
   * The discs in the box's foot, as Claude Code's status line has them: the conversation's context, the session window
   * and the week, each a percent. The time to the reset shows only when it matters: the session past half, the week
   * ahead of its pace.
   */
  let { model, session }: { model?: string | null; session?: string } = $props();
  const R = 6.5;
  const C = 2 * Math.PI * R;
  const CONTEXT_EVERY_MS = 20_000;
  const SESSION_TIME_AT = 50;
  const WEEK_MS = 7 * 24 * 3_600_000;

  let context = $state<number | undefined>();
  $effect(() => {
    const id = session;
    context = undefined;
    if (!id) return;
    const read = () => void api.contextUsage(id).then((u) => (context = u.percentage === undefined ? undefined : Math.round(u.percentage)), () => {});
    read();
    const timer = setInterval(read, CONTEXT_EVERY_MS);
    return () => clearInterval(timer);
  });

  /** One unit: 30m, 1.4h, 2.5d. */
  function left(iso?: string) {
    const ms = iso ? new Date(iso).getTime() - Date.now() : 0;
    if (ms <= 0) return "";
    const hours = ms / 3_600_000;
    if (hours >= 24) return `${+(hours / 24).toFixed(1)}d`;
    return hours >= 1 ? `${+hours.toFixed(1)}h` : `${Math.ceil(ms / 60_000)}m`;
  }
  /** Used more of the week than has gone by. */
  function aheadOfPace(w: UsageWindow) {
    const remaining = w.resetsAt ? new Date(w.resetsAt).getTime() - Date.now() : 0;
    return remaining > 0 && remaining <= WEEK_MS && w.percent > ((WEEK_MS - remaining) / WEEK_MS) * 100;
  }
  const level = (percent: number, warm = 70) => (percent >= 90 ? "hot" : percent >= warm ? "warm" : "cool");

  const discs = $derived.by(() => {
    const data = desk.usage ?? { windows: [], costUsd: 0, error: "the daemon is not reachable" };
    const s = data.windows.find((w) => w.name === "Session");
    const family = model ? modelName(model).split(" ")[0]!.toLowerCase() : "";
    const week = (family && data.windows.find((w) => w.name.toLowerCase().includes(family))) || data.windows.find((w) => w.name === "Weekly");
    const why = `${data.error ?? "no usage reported yet"}${data.needsLogin ? " — reconnect Claude at /claude/login" : ""}`;
    const ahead = week ? aheadOfPace(week) : false;
    return [
      ...(context === undefined ? [] : [{ key: "context", percent: context, level: level(context), time: "", title: `Context: ${context}% full` }]),
      { key: "session", percent: s?.percent, level: s ? level(s.percent) : "none", time: s && s.percent > SESSION_TIME_AT ? left(s.resetsAt) : "", title: s ? `${s.name}: ${s.percent}% used · resets in ${left(s.resetsAt)}` : `Session: unavailable — ${why}` },
      { key: "week", percent: week?.percent, level: week ? (ahead && week.percent < 90 ? "warm" : level(week.percent, 101)) : "none", time: ahead ? left(week?.resetsAt) : "", title: week ? `${week.name}: ${week.percent}% used · resets in ${left(week.resetsAt)}` : `Weekly: unavailable — ${why}` },
    ];
  });
</script>

<span class="rings">
  {#each discs as d (d.key)}
    <span class="ring-mini {d.level}" title={d.title}>
      <span class="disc">
        <svg viewBox="0 0 15 15" aria-hidden="true">
          <circle cx="7.5" cy="7.5" r={R} class="track" />
          {#if d.percent !== undefined}<circle cx="7.5" cy="7.5" r={R} class="fill" stroke-dasharray={C} stroke-dashoffset={C * (1 - Math.min(100, d.percent) / 100)} transform="rotate(-90 7.5 7.5)" />{/if}
        </svg>
        <span>{d.percent ?? "–"}</span>
      </span>
      {#if d.time}<span>{d.time}</span>{/if}
    </span>
  {/each}
</span>
