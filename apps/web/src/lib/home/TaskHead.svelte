<script lang="ts">
  import type { IconName } from "../icons";
  import { md } from "../markdown";
  import type { TaskItem, TaskStatus } from "../types";
  import Icon from "../ui/Icon.svelte";

  /**
   * A task's own page, over the chat about it: what it is, whose it is, what is waiting, and a way to start it. An
   * empty conversation says nothing about the task, so the task comes first.
   */
  let { task, owner, working, start }: { task: TaskItem; owner: string; working: boolean; start: () => void } = $props();
  const LABEL: Record<TaskStatus, string> = { inbox: "Not started", scheduled: "Scheduled", active: "Working", waiting_user: "Waiting on you", waiting_other: "Waiting", done: "Done", dropped: "Dropped" };
  const GLYPH: Record<TaskStatus, IconName> = { inbox: "circle", scheduled: "clock", active: "play", waiting_user: "hand", waiting_other: "hourglass", done: "circleCheck", dropped: "x" };
  const meta = $derived([LABEL[task.status], owner, task.due ? `due ${task.due}` : ""].filter(Boolean).join(" · "));
</script>

<section class="task-head">
  <div class="task-head-line">
    {#if working && task.status === "active"}<span class="spinner"></span>{:else}<Icon name={GLYPH[task.status]} size={14} />{/if}
    <h2 class="task-title">{task.title}</h2>
    <span class="tag">#{task.id}</span>
  </div>
  <div class="task-meta">{meta}</div>
  {#if task.nextAction?.trim()}<div class="task-next"><b>Next</b><div class="task-next-body" {@attach md(task.nextAction)}></div></div>{/if}
  {#if task.notes?.trim()}<div class="task-notes" {@attach md(task.notes)}></div>{/if}
  {#if task.status === "inbox"}<button class="opt task-start" onclick={start}>Start it</button>{/if}
</section>
