<script lang="ts">
  import { untrack } from "svelte";
  import { api } from "../api";
  import { desk } from "../desk.svelte";
  import type { Routine, RoutineAction, RoutineEvent, RoutineFields } from "../types";
  import ConfirmButton from "../ui/ConfirmButton.svelte";
  import Segmented from "../ui/Segmented.svelte";
  import Sheet from "../ui/Sheet.svelte";
  import { BUTTON, ERROR, INPUT, TEXTAREA } from "./controls";
  import EventPicker from "./EventPicker.svelte";
  import Field from "./Field.svelte";
  import { ACTION_LABELS, describeSchedule } from "./routines";

  /**
   * One routine. An existing one saves each field as it is committed, and only that field, so what the form does not
   * show (its code check, a task's project) survives. A new one is created whole.
   */
  type Trigger = "event" | "schedule";
  type TextField = "name" | "schedule" | "filter" | "template";
  type ErrorSlot = TextField | "event" | "action" | "form";

  let { routine, catalog, onclose }: { routine: Routine | null; catalog: readonly RoutineEvent[]; onclose: () => void } = $props();
  const initial = untrack(() => routine);
  const TRIGGERS: readonly { value: Trigger; label: string }[] = [{ value: "event", label: "Event" }, { value: "schedule", label: "Schedule" }];
  const OFFERED: readonly RoutineAction[] = ["notify", "turn", "wake", "triage"];
  const ACTIONS = [...OFFERED, ...(initial?.action === "task" ? (["task"] as const) : [])].map((value) => ({ value, label: ACTION_LABELS[value] }));
  const SAYS_SOMETHING: readonly RoutineAction[] = ["notify", "turn", "wake", "task"];

  let sheet = $state<Sheet>();
  let name = $state(initial?.name ?? "");
  let trigger = $state<Trigger>(initial?.schedule ? "schedule" : "event");
  let event = $state(initial?.event ?? "");
  let schedule = $state(initial?.schedule ?? "");
  let filter = $state(initial?.filter ?? "");
  let action = $state<RoutineAction>(initial?.action ?? "notify");
  let agent = $state(initial?.agent ?? "");
  let template = $state(initial?.template ?? "");
  let errors = $state<Partial<Record<ErrorSlot, string>>>({});
  let busy = $state(false);

  /** What the daemon holds, so committing an untouched field sends nothing. */
  const saved: Record<TextField, string> = { name: initial?.name ?? "", schedule: initial?.schedule ?? "", filter: initial?.filter ?? "", template: initial?.template ?? "" };

  const agents = $derived(desk.agents.filter((a) => a.status !== "closed" || a.slug === agent));
  const preview = $derived(describeSchedule(schedule));
  const valid = $derived(Boolean(name.trim()) && Boolean(trigger === "event" ? event : schedule.trim()) && (action !== "wake" || Boolean(agent)));

  async function patch(slot: ErrorSlot, changes: RoutineFields) {
    if (!initial) return true;
    const result = await api.updateRoutine(initial.id, changes);
    errors = { ...errors, [slot]: result.error };
    return !result.error;
  }

  /** Sends a text field if it changed and can be sent: a blank name or schedule stays unsent, keeping what was saved. */
  async function commit(field: TextField) {
    const values: Record<TextField, string> = { name, schedule, filter, template };
    const value = values[field].trim();
    if (!initial || value === saved[field]) return;
    if ((field === "name" || field === "schedule") && !value) return;
    const changes: RoutineFields = field === "schedule" ? { schedule: value, event: "" } : { [field]: value };
    if (!(await patch(field, changes))) return;
    saved[field] = value;
    if (field === "schedule") event = "";
  }

  async function pickEvent(kind: string) {
    event = kind;
    if (!(await patch("event", { event: kind, schedule: "" }))) return;
    schedule = "";
    saved.schedule = "";
  }

  function chooseAction(next: RoutineAction) {
    action = next;
    // A wake with no agent would be refused; it goes out once the agent is chosen.
    if (next !== "wake" || agent) void patch("action", next === "wake" ? { action: next, agent } : { action: next });
  }

  function chooseAgent(slug: string) {
    agent = slug;
    if (slug) void patch("action", { action, agent: slug });
  }

  async function create() {
    busy = true;
    const result = await api.createRoutine({
      name: name.trim(),
      action,
      template: template.trim(),
      ...(trigger === "event" ? { event, filter: filter.trim() } : { schedule: schedule.trim() }),
      ...(action === "wake" ? { agent } : {}),
    });
    busy = false;
    errors = { ...errors, form: result.error };
    if (!result.error) sheet?.close();
  }

  async function remove() {
    if (!initial) return;
    busy = true;
    const result = await api.deleteRoutine(initial.id);
    busy = false;
    errors = { ...errors, form: result.error };
    if (!result.error) sheet?.close();
  }

  // Escape closes without a blur, so what was being typed is committed here.
  async function closed() {
    const fields: readonly TextField[] = trigger === "schedule" ? ["name", "schedule", "template"] : ["name", "filter", "template"];
    await Promise.all(fields.map(commit));
    onclose();
  }
</script>

<Sheet bind:this={sheet} label={initial ? initial.name : "New routine"} onclose={() => void closed()}>
  {#snippet head()}
    <h2 class="m-0 truncate text-[14px] font-medium">{initial ? name || initial.name : "New routine"}</h2>
  {/snippet}

  <div class="space-y-4">
    <Field label="Name" error={errors.name}>
      <!-- svelte-ignore a11y_autofocus -->
      <input class={INPUT} bind:value={name} autofocus={!initial} onchange={() => void commit("name")} />
    </Field>

    <div class="space-y-2">
      <Segmented options={TRIGGERS} value={trigger} label="Runs on" onchange={(next) => (trigger = next)} />
      {#if trigger === "event"}
        <EventPicker value={event} {catalog} onpick={(kind) => void pickEvent(kind)} />
        {#if errors.event}<p class={ERROR} role="alert">{errors.event}</p>{/if}
      {:else}
        <Field label="Schedule" hint={preview !== schedule.trim() ? preview : undefined} error={errors.schedule}>
          <input class={INPUT} bind:value={schedule} placeholder="30 8 * * *" spellcheck="false" onchange={() => void commit("schedule")} />
        </Field>
      {/if}
    </div>

    {#if trigger === "event"}
      <Field label="Only when it contains" error={errors.filter}>
        <input class={INPUT} bind:value={filter} onchange={() => void commit("filter")} />
      </Field>
    {/if}

    <Field label="Action" group error={errors.action}>
      <Segmented options={ACTIONS} value={action} label="Action" onchange={chooseAction} />
      {#if action === "wake"}
        <select class={INPUT} aria-label="Agent" value={agent} onchange={(e) => chooseAgent(e.currentTarget.value)}>
          <option value="" disabled>Choose an agent</option>
          {#each agents as a (a.slug)}<option value={a.slug}>{a.name}</option>{/each}
        </select>
      {/if}
    </Field>

    {#if SAYS_SOMETHING.includes(action)}
      <Field label="Message" error={errors.template}>
        <textarea class={TEXTAREA} rows="3" bind:value={template} placeholder={"New message from {from}: {text}"} onchange={() => void commit("template")}></textarea>
      </Field>
    {/if}

    <div class="flex flex-wrap items-center gap-3">
      {#if initial}
        <ConfirmButton class={BUTTON} disabled={busy} confirm="Delete for good" onconfirm={() => void remove()}>Delete</ConfirmButton>
      {:else}
        <button type="button" class={BUTTON} disabled={!valid || busy} onclick={() => void create()}>Create</button>
      {/if}
      {#if errors.form}<p class={ERROR} role="alert">{errors.form}</p>{/if}
    </div>
  </div>
</Sheet>
