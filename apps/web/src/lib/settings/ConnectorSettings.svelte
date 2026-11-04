<script lang="ts">
  import { api } from "../api";
  import type { ConnectorDetail, ConnectorSetting } from "../types";
  import Segmented from "../ui/Segmented.svelte";
  import Switch from "../ui/Switch.svelte";
  import { BLOCK_TITLE, INPUT } from "./controls";
  import Field from "./Field.svelte";

  /** A connector's own settings, each saved as it changes. Saving restarts the connector, which answers with its new state. */
  const ON = "1";
  let { name, fields, onupdate }: { name: string; fields: readonly ConnectorSetting[]; onupdate: (fresh: ConnectorDetail) => void } = $props();
  let errors = $state<Record<string, string | undefined>>({});

  async function save(key: string, value: string) {
    const result = await api.patchConnectorSettings(name, { [key]: value });
    errors = { ...errors, [key]: result.error };
    if (result.data) onupdate(result.data);
  }
</script>

{#if fields.length}
  <section>
    <h3 class={BLOCK_TITLE}>Settings</h3>
    <div class="space-y-3">
      {#each fields as s (s.key)}
        {#if s.type === "toggle"}
          <Field label={s.label} hint={s.hint} group error={errors[s.key]}>
            <Switch checked={s.value === ON} label={s.label} onchange={(next) => void save(s.key, next ? ON : "")} />
          </Field>
        {:else if s.type === "select"}
          <Field label={s.label} hint={s.hint} group error={errors[s.key]}>
            <Segmented options={(s.options ?? []).map((value) => ({ value, label: value }))} value={s.value} label={s.label} onchange={(next) => void save(s.key, next)} />
          </Field>
        {:else if s.secret}
          <Field label={s.label} hint={s.hint} error={errors[s.key]}>
            <input class={INPUT} type="password" autocomplete="off" placeholder={s.value ? "Set" : "Not set"} onchange={(e) => e.currentTarget.value && void save(s.key, e.currentTarget.value)} />
          </Field>
        {:else}
          <Field label={s.label} hint={s.hint} error={errors[s.key]}>
            <input class={INPUT} type={s.type === "number" ? "number" : "text"} value={s.value} onchange={(e) => void save(s.key, e.currentTarget.value)} />
          </Field>
        {/if}
      {/each}
    </div>
  </section>
{/if}
