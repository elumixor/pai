<script lang="ts">
  import { progress } from "../progress.svelte";
</script>

<div class="progress" class:on={progress.on} class:done={progress.done} role="progressbar" aria-hidden="true" style="--progress: {progress.value}"><span class="progress-bar"></span></div>
