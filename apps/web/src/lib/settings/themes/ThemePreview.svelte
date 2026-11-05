<script lang="ts">
  import type { ElementId } from "../../theme/catalog";
  import Icon from "../../ui/Icon.svelte";

  /**
   * A short conversation drawn with the chat's own classes, so what shows here is what the app will show. A click on
   * a part opens that element's row in the list.
   */
  let { open, onpick }: { open: ElementId | null; onpick: (id: ElementId) => void } = $props();

  const part = (id: ElementId) => ({ "data-el": id, "data-on": open === id });

  function onclick(event: MouseEvent) {
    const target = (event.target as Element).closest<HTMLElement>("[data-el]");
    if (!target) return;
    event.preventDefault();
    onpick(target.dataset.el as ElementId);
  }
</script>

<!-- A mouse's shortcut to rows the list already offers by keyboard. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="theme-preview" {onclick}>
  <div class="theme-preview-side max-md:hidden">
    <div class="flex h-7 items-center rounded-sm px-1.5 text-(length:--tree-size) font-medium text-(--tree-ink-on) bg-(--tree-bg-on)" {...part("treeActive")}>Flat in Prague</div>
    <div class="flex h-7 items-center rounded-sm px-1.5 text-(length:--tree-size) text-(--tree-ink)"><span class="tree-label" {...part("treeRow")}>Job search</span></div>
    <div class="flex h-7 items-center rounded-sm px-1.5 text-(length:--tree-size) text-(--tree-ink)"><span class="tree-label" {...part("treeRow")}>Tax return</span></div>
  </div>
  <div class="theme-preview-chat">
    <div class="day" {...part("day")}>Today</div>
    <div class="row mine">
      <div class="mine-text" {...part("mine")}><div class="bubble">Did the landlord answer? Draft a reply if so.</div></div>
    </div>
    <div class="row tools tint-muted open">
      <div class="tools-head" {...part("toolLine")}><span>Searched mail</span><Icon name="chevron" size={9} /></div>
      <div class="tools-body">
        <div class="tool-call">
          <div class="tool-call-head"><span class="tool-call-what" {...part("toolCall")}>Search mail</span><span class="tool-call-arg">from:landlord</span></div>
        </div>
      </div>
    </div>
    <div class="row reply">
      <div class="bubble" {...part("assistant")}>
        <h2 class="md-h" {...part("heading")}>He answered this morning</h2>
        <p class="md-p">The flat is <strong {...part("bold")}>still free</strong> and he can show it <em {...part("italic")}>on Thursday</em>. Details are in <a href="https://pai.desk.atmagaming.com" tabindex="-1" {...part("link")}>his mail</a>, under <code class="md-inline" {...part("inlineCode")}>Viewing</code>.</p>
        <blockquote class="md-quote" {...part("quote")}>Thursday at five works for me.</blockquote>
        <pre class="md-code" {...part("codeBlock")}><code>deposit: 2 months
available: 1 December</code></pre>
      </div>
      <div class="row-foot"><time {...part("time")}>14:32</time></div>
    </div>
    <div class="row pill event tint-muted">
      <div class="pill-line" {...part("toolLine")}><span class="pill-text">Added the viewing to your calendar</span><span class="when" {...part("time")}>14:33</span></div>
    </div>
    <div class="row question">
      <div class="q-block">
        <div class="q-body" {...part("question")}><p class="md-p">Send him the reply as drafted?</p></div>
        <div class="q-foot"><div class="q-options"><span class="opt" {...part("option")}>Send</span><span class="opt" {...part("option")}>Change it</span></div></div>
      </div>
    </div>
    <div class="compose chat-compose">
      <div class="compose-row"><div class="input" {...part("compose")}>Message pai</div></div>
    </div>
  </div>
</div>
