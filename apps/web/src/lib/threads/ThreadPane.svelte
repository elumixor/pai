<script lang="ts">
  import { api } from "../api";
  import Compose from "../chat/Compose.svelte";
  import { modelName } from "../format";
  import { md } from "../markdown";
  import { live } from "../stores/live.svelte";
  import type { Question, SessionSummary, Transcript, TranscriptTool, Upload } from "../types";
  import Icon from "../ui/Icon.svelte";

  /**
   * One thread in the terminal's look: `❯` what was said, `⏺` the replies and the tool calls with their results
   * folded under `⎿`, the reply streaming in, a pending question with its buttons. The box is the same as the chat's,
   * in monospace.
   */
  let { session, onclose, onswap }: { session: SessionSummary; onclose: () => void; onswap?: () => void } = $props();

  type Entry =
    | { kind: "user"; key: string; text: string }
    | { kind: "meta"; key: string; text: string }
    | { kind: "assistant"; key: string; text: string; live?: boolean }
    | { kind: "tool"; key: string; id?: string; name: string; input: string; result?: string; live?: boolean; parent?: string }
    | { kind: "notice"; key: string; text: string; level: string };

  let entries = $state<Entry[] | undefined>();
  // svelte-ignore state_referenced_locally
  let status = $state(session.state);
  // svelte-ignore state_referenced_locally
  let model = $state(session.model ?? null);
  let question = $state<{ id: string; questions: Question[]; index: number } | undefined>();
  let log = $state<HTMLDivElement>();
  let box = $state<Compose>();
  let copied = $state(false);
  // svelte-ignore state_referenced_locally
  let title = $state(session.title || session.shortId);
  // svelte-ignore state_referenced_locally
  let adopted = session.kind !== "claude";
  let n = 0;
  const key = () => `e${++n}`;
  const scroll = () => requestAnimationFrame(() => log && (log.scrollTop = log.scrollHeight));
  const toolName = (name: string) => name.replace(/^mcp__/, "").replace(/__/g, ":");

  const render = (message: Transcript): Entry[] => {
    if (message.role === "user") {
      if (message.meta) return [{ kind: "meta", key: key(), text: message.text.replace(/\s+/g, " ").slice(0, 120) }];
      return message.text ? [{ kind: "user", key: key(), text: message.text }] : [];
    }
    const out: Entry[] = [];
    if (message.text) out.push({ kind: "assistant", key: key(), text: message.text });
    for (const tool of message.tools ?? []) out.push(toolEntry(tool));
    return out;
  };
  const toolEntry = (tool: TranscriptTool, live = false): Entry => ({ kind: "tool", key: key(), id: tool.id, name: toolName(tool.name), input: (tool.input ?? "").replace(/^\$ /, ""), result: tool.result, live });

  $effect(() => {
    const id = session.sessionId;
    void api
      .transcript(id, 300, session.cwd)
      .then((history) => (entries = [...history.flatMap(render), ...(entries ?? [])]))
      .catch(() => (entries = entries ?? []))
      .finally(scroll);
    const stop = live.on((event) => {
      if (event.sessionId !== id) return;
      const p = event.payload as { text?: string; summary?: string; name?: string; id?: string; parent?: string; result?: string; questions?: Question[]; status?: string; level?: string; model?: string };
      const list = entries ?? [];
      switch (event.kind) {
        case "session.model":
          model = p.model ?? null;
          break;
        case "session.delta": {
          const last = list[list.length - 1];
          if (last?.kind === "assistant" && last.live) last.text = p.text ?? "";
          else list.push({ kind: "assistant", key: key(), text: p.text ?? "", live: true });
          status = "busy";
          break;
        }
        case "session.tool":
          for (const e of list) if (e.kind === "assistant") e.live = false;
          list.push({ ...toolEntry({ id: p.id, name: p.name ?? "tool", input: p.summary }, true), parent: p.parent } as Entry);
          break;
        case "session.tool_result": {
          const tool = list.find((e): e is Extract<Entry, { kind: "tool" }> => e.kind === "tool" && e.id === p.id);
          if (tool) {
            tool.result = p.result ?? "";
            tool.live = false;
          }
          break;
        }
        case "session.question":
          question = { id: p.id ?? "", questions: p.questions ?? [], index: 0 };
          status = "waiting";
          break;
        case "session.answer":
          question = undefined;
          break;
        case "session.status":
          status = p.status ?? "busy";
          break;
        case "session.notice":
          list.push({ kind: "notice", key: key(), text: p.text ?? "", level: p.level ?? "" });
          break;
        case "session.turn_end":
        case "session.exit":
          for (const e of list) if ("live" in e) e.live = false;
          status = event.kind === "session.exit" ? "detached" : "idle";
          break;
        default:
          return;
      }
      entries = list;
      scroll();
    });
    return stop;
  });

  async function submit(text: string, images: readonly Upload[]) {
    entries = [...(entries ?? []), { kind: "user", key: key(), text: text || "(image)" }];
    scroll();
    if (title === "new thread" && text) title = text.replace(/\s+/g, " ").slice(0, 60);
    // A terminal conversation is resumed by the daemon on its first message from here.
    const result = await api.sendThread(session.sessionId, text, images, adopted ? undefined : { cwd: session.cwd, title: session.title });
    box?.setNote(result.error ?? "");
    if (!result.error) adopted = true;
  }

  async function answer(label: string) {
    if (!question) return;
    await api.answerQuestion(session.sessionId, label);
    question = question.index + 1 < question.questions.length ? { ...question, index: question.index + 1 } : undefined;
  }
  const where = $derived(session.project ?? session.cwd?.replace(/^.*\//, "") ?? "");
  const roots = $derived((entries ?? []).filter((e) => e.kind !== "tool" || !e.parent));
  const childrenOf = (id?: string) => (id ? (entries ?? []).filter((e) => e.kind === "tool" && e.parent === id) : []);
</script>

{#snippet tool(e: Extract<Entry, { kind: "tool" }>)}
  <div class="entry tool" class:live={e.live}>
    <span class="mark">⏺</span>
    <div class="body"><span class="tool-name">{e.name}</span>{#if e.input}<span class="tool-args">({e.input})</span>{/if}</div>
    {#if e.result !== undefined}<div class="result"><span class="mark">⎿</span><pre class="body">{e.result || "(no output)"}</pre></div>{/if}
    {#each childrenOf(e.id) as child (child.key)}{#if child.kind === "tool"}{@render tool(child)}{/if}{/each}
  </div>
{/snippet}

<header class="panel-head">
  <Icon name={session.kind === "claude" ? "terminal" : session.kind === "code" ? "code" : "message"} size={14} />
  <h2 class="ellipsis" title={title}>{title}</h2>
  <span class="dim ellipsis" title={session.cwd ?? ""}>{where}</span>
  {#if session.parent}<span class="dim" title="started by session {session.parent}">↳ from {session.parent.slice(0, 6)}</span>{/if}
  <span class="tag">{status}</span>
  {#if model}<span class="tag model" title="the model answering this thread">{modelName(model)}</span>{/if}
  <button class="iconbtn slim session-id" class:copied title="session {session.sessionId}&#10;click: copy the id" onclick={() => (navigator.clipboard?.writeText(session.sessionId), (copied = true), setTimeout(() => (copied = false), 1200))}><span class="mono">{session.shortId}</span><Icon name="copy" size={11} /></button>
  <span class="grow"></span>
  <button class="iconbtn" title="interrupt" aria-label="Interrupt" onclick={() => void api.stop(session.sessionId)}><Icon name="stop" size={14} /></button>
  {#if onswap}<button class="iconbtn" title="move to the other pane" aria-label="Move to the other pane" onclick={onswap}><Icon name="split" size={14} /></button>{/if}
  <button class="iconbtn" title="close" aria-label="Close" onclick={onclose}><Icon name="x" size={14} /></button>
</header>
<div class="tui" bind:this={log}>
  {#if !entries}
    <div class="skeleton skeleton-lines" aria-hidden="true">{#each [72, 54, 86, 40, 66, 48, 78, 58] as w, i (i)}<span class="sk-line" style="--w: {w}%"></span>{/each}</div>
  {:else if !entries.length}
    <p class="hint">Nothing here yet.</p>
  {/if}
  {#each roots as e (e.key)}
    {#if e.kind === "user"}
      <div class="entry user"><span class="mark">❯</span><div class="body">{e.text}</div></div>
    {:else if e.kind === "meta"}
      <div class="entry meta" title={e.text}><span class="mark">·</span><div class="body ellipsis">{e.text}</div></div>
    {:else if e.kind === "assistant"}
      <div class="entry assistant" class:live={e.live}><span class="mark">⏺</span><div class="body" {@attach md(e.text)}></div></div>
    {:else if e.kind === "notice"}
      <div class="entry notice {e.level}"><span class="mark">{e.level === "output" ? "⏺" : "!"}</span><pre class="body">{e.text}</pre></div>
    {:else}
      {@render tool(e)}
    {/if}
  {/each}
  {#if question}
    {@const q = question.questions[question.index]}
    {#if q}
      <div class="question">
        <p class="q-head">{q.header}</p>
        <p class="q-text">{q.question}</p>
        <div class="q-options">{#each q.options as option (option.label)}<button class="btn" title={option.description} onclick={() => void answer(option.label)}>{option.label}</button>{/each}</div>
      </div>
    {/if}
  {/if}
</div>
<Compose bind:this={box} mono placeholder="Message… (paste an image)" draftKey={`tui:${session.sessionId}`} session={() => session.sessionId} foot={session.project ?? (session.kind === "main" ? "workspace" : (session.cwd?.replace(/^.*\//, "") ?? ""))} {submit} />
