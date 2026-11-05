<script lang="ts">
  /** A card's buttons that take the user somewhere. Outside our own domains the host is on the button, so a model cannot dress a link up as something else. */
  let { actions, class: className = "" }: { actions: readonly { readonly label: string; readonly url: string }[]; class?: string } = $props();

  const OWN = /(^|\.)atmagaming\.com$/;
  const foreign = (url: string) => {
    const { host } = new URL(url, location.href);
    return OWN.test(host) || host === location.host ? undefined : host;
  };
</script>

{#each actions as action (action.url)}
  {@const host = foreign(action.url)}
  <a class={className} href={action.url} target="_blank" rel="noopener">{action.label}{#if host}<span class="opacity-60"> · {host}</span>{/if}</a>
{/each}
