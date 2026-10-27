<script lang="ts">
  import Sheet from "./Sheet.svelte";
  import { dialogs } from "./dialogs.svelte";

  let values = $state<Record<string, string>>({});
  $effect(() => {
    const open = dialogs.open;
    values = open ? Object.fromEntries(open.fields.map((f) => [f.name, f.value ?? ""])) : {};
  });

  function submit(event: SubmitEvent) {
    event.preventDefault();
    dialogs.open?.resolve(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim()])));
  }
</script>

{#if dialogs.open}
  {@const open = dialogs.open}
  <Sheet onclose={() => open.resolve(undefined)}>
    <form method="dialog" onsubmit={submit}>
      <h3>{open.title}</h3>
      {#if open.description}<p class="dim">{open.description}</p>{/if}
      {#each open.fields as field, i (field.name)}
        <label class="sheet-field">
          <span>{field.label}</span>
          <!-- svelte-ignore a11y_autofocus -->
          <input name={field.name} bind:value={values[field.name]} placeholder={field.placeholder ?? ""} required={field.required} autofocus={i === 0} />
        </label>
      {/each}
      <div class="sheet-actions">
        <button class="btn" type="button" onclick={() => open.resolve(undefined)}>Cancel</button>
        <button class="btn primary" type="submit">{open.submit ?? "OK"}</button>
      </div>
    </form>
  </Sheet>
{/if}
