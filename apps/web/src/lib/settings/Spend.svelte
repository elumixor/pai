<script lang="ts">
  import { api } from "../api";
  import { capital, usd } from "../format";
  import type { SpendBucket, SpendReport } from "../types";
  import Segmented from "../ui/Segmented.svelte";
  import { ERROR, SKELETON } from "./controls";

  /** Where the time, tokens and money went: what it would cost at API prices, beside what it actually costs. */
  const DAYS = [7, 30, 90] as const;
  const GROUPINGS = ["agent", "project", "model", "source"] as const;
  const PAID_NOTE = "Paid is the plan's fee for the period, shared out by each one's API price, plus what the gateway metered. The plan's price comes from the login's tier; PAI_CLAUDE_PLAN_USD overrides it.";
  let days = $state<(typeof DAYS)[number]>(30);
  let by = $state<(typeof GROUPINGS)[number]>("agent");
  let report = $state<SpendReport | undefined>();
  let error = $state("");
  $effect(() => {
    const n = days;
    void api.spend(n).then((r) => (report = r), (e: Error) => (error = e.message));
  });
  const tokens = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
  const hours = (ms: number) => (ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)}h` : `${Math.round(ms / 60_000)}m`);
  const tierName = (tier?: string) => (tier ? tier.replace(/^default_claude_/, "").replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()) : "plan");
  const all = (b: SpendBucket) => b.input + b.output + b.cacheRead + b.cacheWrite;
  const peak = $derived(Math.max(...(report?.daily ?? []).map((d) => d.apiUsd), 0.01));
  const rows = $derived(report?.by[by] ?? []);
  const top = $derived(Math.max(...rows.map((b) => b.apiUsd), 0.01));
</script>

<div class="mb-3"><Segmented options={DAYS.map((d) => ({ value: d, label: `${d}d` }))} value={days} label="Period" onchange={(next) => (days = next)} /></div>
{#if error}
  <p class={ERROR} role="alert">{error}</p>
{:else if !report}
  <div class="h-40 {SKELETON}" aria-hidden="true"></div>
{:else}
  {@const t = report.total}
  {@const box = report.box?.periodUsd ?? 0}
  <div class="spend-tiles" data-testid="spend">
    <div class="spend-tile"><span class="dim">At API prices</span><strong>{usd(t.apiUsd)}</strong><span class="dim">without the plan</span></div>
    <div class="spend-tile" title="{PAID_NOTE}&#10;Claude {tierName(report.plan.tier)} {usd(report.plan.periodUsd)} ({usd(report.plan.monthlyUsd)}/mo){box ? `, box ${usd(box)}` : ''}"><span class="dim">Actually paid</span><strong>{usd(t.realUsd + box)}</strong><span class="dim">Claude {tierName(report.plan.tier)}</span></div>
    <div class="spend-tile"><span class="dim">Saved</span><strong>{usd(t.savedUsd)}</strong>{#if t.realUsd}<span class="dim">{(t.apiUsd / t.realUsd).toFixed(1)}× the plan</span>{/if}</div>
    <div class="spend-tile"><span class="dim">Tokens</span><strong>{tokens(all(t))}</strong><span class="dim">{t.calls} calls</span></div>
    <div class="spend-tile"><span class="dim">Time in turns</span><strong>{hours(t.ms)}</strong></div>
    {#if report.credits.monthlyUsd}<div class="spend-tile"><span class="dim">API credits</span><strong>{usd(report.credits.usedUsd)}</strong><span class="dim">of {usd(report.credits.monthlyUsd)} a month</span></div>{/if}
  </div>
  <div class="spend-days">
    {#each report.daily as d (d.key)}
      <div class="spend-day" title="{d.key}&#10;{usd(d.apiUsd)} at API prices · {usd(d.realUsd)} paid&#10;{tokens(all(d))} tokens{d.ms ? ` · ${hours(d.ms)} in turns` : ''}"><span class="bar api" style="height:{(d.apiUsd / peak) * 100}%"></span><span class="bar real" style="height:{(d.realUsd / peak) * 100}%"></span></div>
    {/each}
  </div>
  {#if report.daily.length}<div class="spend-axis dim"><span>{report.daily[0]!.key}</span><span>{report.daily.at(-1)!.key}</span></div>{/if}
  <div class="spend-legend dim"><span class="key api"></span>API price<span class="key real"></span>Paid</div>
  <Segmented options={GROUPINGS.map((v) => ({ value: v, label: capital(v) }))} value={by} label="Group by" onchange={(next) => (by = next)} />
  <div class="spend-table">
    <div class="spend-row head"><span>{capital(by)}</span><span></span><span>API price</span><span>Paid</span><span>Tokens</span><span>Time</span></div>
    {#each rows as b (b.key)}
      <div class="spend-row" title="{tokens(b.input + b.cacheWrite)} in · {tokens(b.cacheRead)} cached · {tokens(b.output)} out · {b.calls} calls">
        <span class="ellipsis">{b.key}</span><span class="spend-share"><span style="width:{(b.apiUsd / top) * 100}%"></span></span><span class="num">{usd(b.apiUsd)}</span><span class="num">{usd(b.realUsd)}</span><span class="num dim">{tokens(all(b))}</span><span class="num dim">{b.ms ? hours(b.ms) : ""}</span>
      </div>
    {/each}
  </div>
{/if}
