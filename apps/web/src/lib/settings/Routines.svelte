<script lang="ts">
  import { api } from "../api";
  import { ago } from "../format";
  import type { Automation, ModuleInfo } from "../types";
  import { dialogs } from "../ui/dialogs.svelte";
  import Icon from "../ui/Icon.svelte";

  /** What makes pai act on its own: on an event (or a schedule), a check, an action. */
  let rules = $state<Automation[] | undefined>();
  let mods = $state<ModuleInfo[]>([]);
  let error = $state("");
  const ACTIONS: Record<string, string> = { notify: "notify me", turn: "open a conversation with it", task: "start a task in a project", wake: "wake its agent", triage: "triage it" };
  const load = () =>
    Promise.all([api.automations(), api.modules().catch(() => [] as ModuleInfo[])]).then(
      ([r, m]) => ((rules = r), (mods = m)),
      (e: Error) => (error = e.message),
    );
  $effect(() => void load());
  const events = $derived([...mods.flatMap((m) => m.events?.map((e) => e.kind) ?? []), "session.turn_end", "session.question", "task.created", "daemon.started", "daemon.updated"]);

  async function form(initial?: Automation) {
    const answer = await dialogs.ask({
      title: initial ? "Edit routine" : "New routine",
      description: "When an event with this kind (and, if given, this text somewhere in its payload) happens, run the action. {field} in the message reads the event.",
      fields: [
        { name: "name", label: "Name", value: initial?.name ?? "", required: true },
        { name: "event", label: `Event (${events.slice(0, 4).join(", ")}, …)`, value: initial?.event ?? "", required: true },
        { name: "filter", label: "Only when the payload contains", value: initial?.filter ?? "" },
        { name: "action", label: "Action: notify · turn · task", value: initial?.action ?? "notify", required: true },
        { name: "project", label: "Project for a task", value: initial?.project ?? "" },
        { name: "template", label: "Message, e.g. New LinkedIn message from {from}: {text}", value: initial?.template ?? "" },
      ],
      submit: initial ? "Save" : "Create",
    });
    if (!answer) return;
    const result = initial ? await api.updateAutomation(initial.id, answer as Partial<Automation>) : await api.createAutomation(answer as Partial<Automation>);
    if (result.error) error = result.error;
    void load();
  }
</script>

<h2 class="dash-title">Routines <span class="grow"></span><button class="btn primary" onclick={() => void form()}><Icon name="plus" size={13} /><span>New</span></button></h2>
<p class="hint">on &lt;event&gt; → &lt;action&gt;. Tasks are capped at 6 an hour: each one is a Claude session.</p>
{#if error}<p class="hint">{error}</p>{/if}
{#if rules?.length}
  <div class="auto-list" data-testid="routines">
    {#each rules as rule (rule.id)}
      <div class="auto-row" class:off={!rule.enabled}>
        <span class="dot {rule.enabled ? 'idle' : 'dead'}"></span>
        <div class="auto-text"><span class="setting-title">{rule.name}</span><span class="dim">on {rule.event || "a schedule"}{rule.filter ? ` containing "${rule.filter}"` : ""} → {ACTIONS[rule.action] ?? rule.action}{rule.project ? ` ${rule.project}` : ""}</span></div>
        <span class="dim">{rule.runs ? `${rule.runs}× · last ${rule.lastRun ? ago(rule.lastRun) : ""}` : "never ran"}</span>
        <button class="iconbtn" title={rule.enabled ? "disable" : "enable"} aria-label={rule.enabled ? "Disable" : "Enable"} onclick={async () => (await api.updateAutomation(rule.id, { enabled: !rule.enabled }), load())}><Icon name={rule.enabled ? "stop" : "play"} size={13} /></button>
        <button class="iconbtn" title="edit" aria-label="Edit" onclick={() => void form(rule)}><Icon name="settings" size={13} /></button>
        <button class="iconbtn" title="delete" aria-label="Delete" onclick={async () => (await api.deleteAutomation(rule.id), load())}><Icon name="x" size={13} /></button>
      </div>
    {/each}
  </div>
{:else if rules}
  <div class="empty"><p class="dim">No routines yet. Try: on linkedin.message → notify.</p></div>
{:else}
  <p class="hint">…</p>
{/if}
<h3 class="section-title">Events you can listen to</h3>
<div class="chips">{#each events as e (e)}<span class="tag">{e}</span>{/each}</div>
