<script lang="ts">
  import { Plug } from "lucide-svelte";
  import { api } from "../api";
  import { ago, capital, clock } from "../format";
  import type { ConnectorDetail, ConnectorLogLine, ConnectorState, ConnectorSummary, RoutineEvent } from "../types";
  import Sheet from "../ui/Sheet.svelte";
  import Switch from "../ui/Switch.svelte";
  import ConnectorAccounts from "./ConnectorAccounts.svelte";
  import ConnectorActions from "./ConnectorActions.svelte";
  import ConnectorSettings from "./ConnectorSettings.svelte";
  import { BLOCK_TITLE, BUTTON, ERROR, SKELETON } from "./controls";
  import EventPill from "./EventPill.svelte";

  /** Everything about one connector; a block with nothing to show is not drawn. */
  const OFF_KEY = "off";
  const OFF_VALUE = "1";
  const STATE: Record<ConnectorState, string> = { signed_in: "Connected", signed_out: "Not connected", broken: "Needs attention" };
  const LOG_TINT: Record<ConnectorLogLine["level"], string> = { info: "text-ink-45", warn: "text-warn", error: "text-hot" };
  const SKELETON_BLOCKS = ["h-10", "h-24", "h-16"];
  const FOLD = "cursor-pointer text-[12px] font-medium text-ink-45";

  let { summary, onclose }: { summary: ConnectorSummary; onclose: () => void } = $props();
  let detail = $state<ConnectorDetail | undefined>();
  let error = $state("");
  let switchTo = $state<boolean | undefined>();

  $effect(() => {
    void api.connector(summary.name).then((d) => (detail = d), (e: Error) => (error = e.message));
  });

  const shown = $derived(detail ?? summary);
  const off = $derived(detail?.settings.find((s) => s.key === OFF_KEY));
  const fix = $derived(shown.status.state === "signed_in" ? undefined : shown.status.fix);
  const fields = $derived(detail?.settings.filter((s) => s.key !== OFF_KEY) ?? []);
  const catalog = $derived<readonly RoutineEvent[]>(detail?.events.map((e) => ({ kind: e.kind, title: e.title, description: e.description, source: summary.name, sourceTitle: summary.title, icon: summary.icon })) ?? []);

  async function toggle(on: boolean) {
    switchTo = on;
    const result = await api.patchConnectorSettings(summary.name, { [OFF_KEY]: on ? "" : OFF_VALUE });
    switchTo = undefined;
    error = result.error ?? "";
    if (result.data) detail = result.data;
  }
</script>

<Sheet label={summary.title} {onclose}>
  {#snippet head()}
    <div class="flex items-center gap-3">
      <span class="grid size-10 shrink-0 place-items-center overflow-hidden rounded-[9px] bg-ink-5 text-ink-45">
        {#if summary.icon}<img src={summary.icon} alt="" class="size-full object-cover" />{:else}<Plug size={18} />{/if}
      </span>
      <div class="min-w-0 flex-1">
        <h2 class="m-0 truncate text-[14px] font-medium">{summary.title}</h2>
        <p class="m-0 truncate text-[12px] text-ink-45">{shown.status.detail || STATE[shown.status.state]}</p>
      </div>
      {#if !detail || off}
        <Switch checked={switchTo ?? (off ? !off.value : summary.enabled)} label="{summary.title} on" disabled={!off || switchTo !== undefined} onchange={(next) => void toggle(next)} />
      {/if}
    </div>
  {/snippet}

  <div class="space-y-5">
    {#if error}<p class={ERROR} role="alert">{error}</p>{/if}
    {#if detail}
      {#if detail.error || fix || detail.problems.length}
        <section class="space-y-2">
          {#if detail.error}<p class={ERROR}>{detail.error}</p>{/if}
          {#each detail.problems as p (p.title)}
            <div class="text-[13px]">
              <p class="m-0 font-medium text-warn">{p.title}</p>
              {#if p.detail}<p class="m-0 text-ink-45">{p.detail}</p>{/if}
              {#if p.action}<p class="m-0 text-ink-45">{p.action}</p>{/if}
            </div>
          {/each}
          {#if fix}<a class="{BUTTON} text-ink no-underline hover:no-underline" href={fix.url} target="_blank" rel="noreferrer">{fix.label}</a>{/if}
        </section>
      {/if}

      {#if detail.accounts}
        <ConnectorAccounts name={summary.name} accounts={detail.accounts} onupdate={(fresh) => (detail = fresh)} />
      {/if}
      <ConnectorActions name={summary.name} actions={detail.actions} onupdate={(fresh) => (detail = fresh)} />
      <ConnectorSettings name={summary.name} {fields} onupdate={(fresh) => (detail = fresh)} />

      {#if detail.tools.length}
        <section>
          <h3 class={BLOCK_TITLE}>Tools</h3>
          <ul class="m-0 list-none space-y-1.5 p-0 text-[13px]">
            {#each detail.tools as tool (tool.name)}
              <li><span>{capital(tool.name.replace(/_/g, " "))}</span><span class="block line-clamp-2 text-[12px] text-ink-45">{tool.description}</span></li>
            {/each}
          </ul>
        </section>
      {/if}

      {#if detail.events.length}
        <section>
          <h3 class={BLOCK_TITLE}>Events</h3>
          <ul class="m-0 list-none space-y-2.5 p-0 text-[12px] text-ink-45">
            {#each detail.events as e (e.kind)}
              <li class="space-y-0.5">
                <EventPill kind={e.kind} {catalog} />
                <span class="block">{e.description}</span>
                <span class="block text-ink-30">{e.lastAt ? `Last ${ago(e.lastAt)} ago` : "Never"}</span>
              </li>
            {/each}
          </ul>
        </section>
      {/if}

      {#if detail.instructions}
        <details>
          <summary class={FOLD}>Instructions</summary>
          <p class="m-0 mt-2 text-[13px] whitespace-pre-wrap text-ink-70">{detail.instructions}</p>
        </details>
      {/if}
      {#if detail.logs.length}
        <details>
          <summary class={FOLD}>Logs</summary>
          <div class="mt-2 max-h-60 overflow-y-auto rounded-sm bg-ink-5 p-2 font-mono text-[11px] leading-4">
            {#each detail.logs as line, i (i)}
              <div class="break-words {LOG_TINT[line.level]}"><span class="text-ink-30">{clock(line.at)}</span> {line.text}</div>
            {/each}
          </div>
        </details>
      {/if}
    {:else if !error}
      <div class="space-y-3" aria-hidden="true">
        {#each SKELETON_BLOCKS as height (height)}<div class="{height} {SKELETON}"></div>{/each}
      </div>
    {/if}
  </div>
</Sheet>
