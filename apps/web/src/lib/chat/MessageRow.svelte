<script lang="ts">
  import { mapsUrl, placeText } from "$protocol/rich";
  import { mapUrl } from "../api";
  import { desk } from "../desk.svelte";
  import { clock, firstLine } from "../format";
  import { kindIcon, kindTint } from "../kinds";
  import { md, mdInline, mdTimed } from "../markdown";
  import type { LogMessage } from "../types";
  import Icon from "../ui/Icon.svelte";
  import { bodyPeek } from "../ui/peek.svelte";
  import AnswerButtons from "./AnswerButtons.svelte";
  import type { RowContext } from "./context";
  import DraftCard from "./DraftCard.svelte";
  import { eventIcon, excerptOf, lineOf, parseReply, type ReplyQuote } from "./model";
  import Pictures from "./Pictures.svelte";
  import QuoteRef from "./QuoteRef.svelte";

  /** One row of the log, drawn by its kind: his bubble, a reply, a card for work handed down or up, an ask, an event. */
  let { m, ctx, key, attach = () => undefined }: { m: LogMessage; ctx: RowContext; key: string; attach?: (node: HTMLElement) => (() => void) | undefined } = $props();

  /** A message of his longer than this folds to three lines with "Show more". */
  const FOLD_CHARS = 240;
  const quoted = $derived(parseReply(m.body));
  const bodyText = $derived(quoted?.text ?? m.body);
  const shape = $derived.by(() => {
    if (m.meta.place) return "place";
    if (m.meta.draftId && m.meta.draft) return "draft";
    switch (m.kind) {
      case "chat":
        return ctx.mine(m) ? "mine" : "reply";
      // Handed to this agent by its parent: reads as the message it is, not a card about one.
      case "delegate":
        return ctx.mine(m) && m.to === ctx.agent ? "mine" : "card";
      // In its own chat what an agent hands back is its reply.
      case "report":
      case "response":
        return m.from === ctx.agent ? "reply" : "card";
      case "request":
        return "card";
      case "ask":
        return "ask";
      case "answer":
        return m.from === "user" ? "answer-mine" : "answer";
      case "notice":
        return "notice";
      default:
        return "event";
    }
  });
  const open = $derived(ctx.isOpen(key));

  // ---- his bubble ----
  const long = $derived(bodyText.length > FOLD_CHARS || bodyText.split("\n").length > 3);
  let unfolded = $state(false);
  let bubble = $state<HTMLDivElement>();
  const from = $derived(m.from === "user" ? undefined : ctx.nameOf(m.from));
  /** Unfolding grows the bubble to its height, folding shrinks it back; the transition needs a number at both ends. */
  function fold() {
    if (!bubble) return void (unfolded = !unfolded);
    const node = bubble;
    node.style.maxHeight = `${node.scrollHeight}px`;
    void node.offsetHeight;
    unfolded = !unfolded;
    node.style.maxHeight = unfolded ? `${node.scrollHeight}px` : "calc(var(--body-lh) * 3)";
    const settle = (event: TransitionEvent) => {
      if (event.propertyName !== "max-height") return;
      node.style.maxHeight = "";
      node.removeEventListener("transitionend", settle);
    };
    node.addEventListener("transitionend", settle);
  }

  // ---- a card: work handed down or reported back ----
  const down = $derived(m.kind === "delegate" || m.kind === "request");
  const party = $derived(m.kind === "delegate" ? m.to : m.kind === "report" ? m.from : down ? m.from : m.to);
  const verb = $derived(({ delegate: "called", report: "completed", request: "asked for", response: "answered" } as Record<string, string>)[m.kind] ?? "");
  const target = $derived(m.to !== ctx.agent && m.to !== ctx.parent && m.to !== "user" && m.to !== party ? ctx.nameOf(m.to) : "");
  const openable = $derived(Boolean(desk.bySlug(party)) && party !== ctx.agent);
  const status = $derived(desk.bySlug(party)?.status);

  // ---- an ask ----
  const askId = $derived(m.meta.askId);
  const askOpen = $derived(askId !== undefined && ctx.openAsks.has(askId));
  const answer = $derived(askId !== undefined ? ctx.answers.get(askId) : undefined);
  /** A task done somewhere else (a reconnect page) leads with that place, as a button. */
  const action = $derived(/\[([^\]]+)\]\(((?:https?:\/\/|\/)[^)\s]+)\)/.exec(m.body));

  // ---- an answer: his bubble, quoting the question it answers ----
  const answerQuote = $derived<ReplyQuote | undefined>(m.meta.quote ? { from: ctx.nameOf(m.meta.quote.from), at: m.meta.quote.at ?? 0, excerpt: m.meta.quote.excerpt, messageId: m.meta.quote.messageId } : undefined);

  const peekRow = (body: string, foot: string) => bodyPeek.arm(`m${m.id}`, () => ({ body, foot }));
  const time = $derived(new Date(m.createdAt).toLocaleString());
</script>

{#snippet chevron()}<Icon name="chevron" size={9} />{/snippet}
{#snippet live(slug: string)}
  {#if status === "working"}<span class="live" data-agent={slug}><span class="spinner" title="working now"></span></span>{:else if status === "waiting"}<span class="live" data-agent={slug}><span class="attention" title="waiting on you"><Icon name="hand" size={11} /></span></span>{/if}
{/snippet}

{#if shape === "place" && m.meta.place}
  {@const place = m.meta.place}
  <a {@attach attach} class="row place-card" href={mapsUrl(place)} target="_blank" rel="noopener" data-message={m.id} data-at={m.createdAt} data-key={key} title={placeText(place)}>
    <img class="place-map" src={mapUrl(place.latitude, place.longitude)} alt="map of {place.title ?? 'the place'}" loading="lazy" />
    <div class="place-text"><b class="place-name">{place.title ?? "Location"}</b>{#if place.address}<span class="place-address">{place.address}</span>{/if}<span class="when">{clock(m.createdAt)}</span></div>
  </a>
{:else if shape === "draft" && m.meta.draftId && m.meta.draft}
  <DraftCard id={m.meta.draftId} draft={m.meta.draft} from={ctx.nameOf(m.from)} message={m} onchanged={ctx.draftsChanged} {attach} />
{:else if shape === "mine" || shape === "answer-mine"}
  {@const quote = shape === "answer-mine" ? answerQuote : quoted}
  <div {@attach attach} class="row mine" class:folded={long && !unfolded} data-message={m.id} data-task={m.taskId ?? ""} data-at={m.createdAt} data-key={key} data-kind="user">
    <Pictures images={m.meta.images} files={m.meta.files} />
    {#if bodyText.trim()}
      <div class="mine-text">
        {#if from}<div class="row-from"><b>{from}</b>{#if m.taskId}<span class="tag">#{m.taskId}</span>{/if}</div>{/if}
        {#if quote}<QuoteRef {quote} onjump={ctx.jump} />{/if}
        {#if long}
          <div class="bubble" bind:this={bubble} {@attach md(bodyText)}></div>
          <div class="row-foot"><button class="more" onclick={fold}>{unfolded ? "Show less" : "Show more"}</button><span class="grow"></span><time title={time}>{clock(m.createdAt)}</time>{#if m.from === "user"}<span class="tick" title="pai has it"><Icon name="check" size={9} /></span>{/if}</div>
        {:else}
          <div class="bubble" {@attach mdTimed(bodyText, m.createdAt, m.from === "user")}></div>
        {/if}
      </div>
    {:else}
      <div class="row-foot"><span class="grow"></span><time title={time}>{clock(m.createdAt)}</time></div>
    {/if}
  </div>
{:else if shape === "reply"}
  <div {@attach attach} class="row reply" data-message={m.id} data-at={m.createdAt} data-key={key} data-kind="reply">
    {#if quoted}<QuoteRef quote={quoted} onjump={ctx.jump} />{/if}
    <div class="bubble" {@attach mdTimed(bodyText, m.createdAt)}></div>
  </div>
{:else if shape === "card"}
  <button
 {@attach attach}    class="row card pill {m.kind} tint-{kindTint(m.kind)}"
    class:mine={ctx.mine(m)}
    class:open
    data-message={m.id}
    data-task={m.taskId ?? ""}
    data-at={m.createdAt}
    data-key={key}
    onclick={() => (openable ? ctx.openAgent(party, m.id) : ctx.toggle(key))}
    {@attach peekRow(m.body, `${time}${openable ? ` · click opens ${ctx.nameOf(party)}` : ""}`)}
  >
    {#if down}
      <span class="pill-line"><span>{m.kind === "delegate" ? "Delegated to" : "Asked"}</span><Icon name="rocket" size={10} />{@render live(party)}<b>{ctx.nameOf(party)}</b>{#if target}<b>{target}</b>{/if}{#if m.taskId}<span class="tag">#{m.taskId}</span>{/if}{@render chevron()}</span>
    {:else}
      <span class="pill-line"><Icon name="rocket" size={10} />{@render live(party)}<span class="ellipsis pill-text" {@attach mdInline(lineOf(m, `${ctx.nameOf(m.from)} ${verb}: ${firstLine(m.body)}`))}></span><span class="when">{clock(m.createdAt)}</span>{#if m.taskId}<span class="tag">#{m.taskId}</span>{/if}{@render chevron()}</span>
    {/if}
    <div class="card-body" {@attach md(m.body)}></div>
  </button>
{:else if shape === "ask" && !askOpen && askId !== undefined}
  <!-- Decided: one green line — what was decided — with the question and the answer behind a click. -->
  <button {@attach attach} class="row pill decision tint-ok" class:open data-message={m.id} data-ask={askId} data-task={m.taskId ?? ""} data-at={m.createdAt} data-key={key} data-testid="ask" onclick={() => ctx.toggle(key)}>
    <span class="pill-line"><Icon name={kindIcon("answered")} size={10} /><span class="ellipsis pill-text" {@attach mdInline(lineOf(m, answer ? `${firstLine(m.body)} — ${answer}` : firstLine(m.body)))}></span><span class="when">{clock(m.createdAt)}</span>{@render chevron()}</span>
    <div class="event-body">
      <div {@attach md(m.body)}></div>
      {#if answer !== undefined}<div class="q-answer"><Icon name="check" size={10} /><span>{answer}</span></div>{:else}<span class="dim">Answered</span>{/if}
    </div>
  </button>
{:else if shape === "ask"}
  <div {@attach attach} class="row question tint-warn" class:open={askOpen} class:answered={!askOpen} data-message={m.id} data-ask={askId ?? ""} data-task={m.taskId ?? ""} data-at={m.createdAt} data-key={key} data-testid="ask">
    <div class="q-meta">
      <Icon name={kindIcon("approval")} size={10} /><b>{askOpen ? "Action needed" : "Decision made"}</b><span>{ctx.agent === m.from ? "" : ` · ${ctx.nameOf(m.from)}`}</span>
      {#if m.meta.priority && m.meta.priority !== "normal"}<span class="tag prio-{m.meta.priority}">{m.meta.priority}</span>{/if}
    </div>
    {#if m.meta.breadcrumb}<div class="q-crumb">{m.meta.breadcrumb}</div>{/if}
    <div class="q-body" {@attach md(m.body)}></div>
    <div class="q-foot">
      {#if askOpen && askId !== undefined}
        {@const options = m.meta.options ?? []}
        <div class="q-options">
          {#if action}<a class="opt" href={action[2]} target="_blank" rel="noopener">{action[1]}</a>{/if}
          <AnswerButtons
            {options}
            freeText={m.meta.freeText !== false || !options.length}
            onreply={(text) => void ctx.answerAsk(askId, text)}
            onwords={() => ctx.pinAnswer(m.body, (text) => ctx.answerAsk(askId, text))}
            ondrop={() => void ctx.dropAsk(askId)}
          />
        </div>
      {:else if answer !== undefined}
        <div class="q-answer"><Icon name="check" size={10} /><span>{answer}</span></div>
      {:else}
        <div class="q-answer dim">Answered</div>
      {/if}
      <time title={time}>{clock(m.createdAt)}</time>
    </div>
  </div>
{:else if shape === "answer"}
  <div {@attach attach} class="row answer pill tint-ok" data-message={m.id} data-at={m.createdAt} data-key={key}>
    <span class="pill-line"><Icon name={kindIcon("answered")} size={10} /><span class="ellipsis pill-text">{ctx.nameOf(m.from)} answered: {m.body}</span><span class="when">{clock(m.createdAt)}</span></span>
  </div>
{:else if shape === "notice"}
  <button {@attach attach} class="row notice pill tint-muted" class:open data-message={m.id} data-at={m.createdAt} data-key={key} onclick={() => ctx.toggle(key)}>
    <span class="pill-line"><Icon name={kindIcon("notice")} size={10} /><span class="ellipsis pill-text" {@attach mdInline(lineOf(m))}></span><span class="when">{clock(m.createdAt)}</span>{@render chevron()}</span>
    <div class="event-body" {@attach md(m.body)}></div>
  </button>
{:else}
  <button
 {@attach attach}    class="row event pill tint-{m.meta.event === 'error' ? 'hot' : 'muted'}"
    class:open
    data-message={m.id}
    data-task={m.taskId ?? ""}
    data-at={m.createdAt}
    data-key={key}
    onclick={() => ctx.toggle(key)}
    {@attach peekRow(m.body, [time, m.meta.link ? "has a link" : ""].filter(Boolean).join(" · "))}
  >
    <span class="pill-line"><Icon name={eventIcon(m)} size={10} /><span class="ellipsis pill-text" {@attach mdInline(lineOf(m))}></span><span class="when">{clock(m.createdAt)}</span>{@render chevron()}</span>
    <div class="event-body">
      <div {@attach md(m.body)}></div>
      {#if m.meta.link}<a href={m.meta.link} target="_blank" rel="noreferrer" onclick={(e) => e.stopPropagation()}><Icon name="external" size={10} /> open</a>{/if}
    </div>
  </button>
{/if}
