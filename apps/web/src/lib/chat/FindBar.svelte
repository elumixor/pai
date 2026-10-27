<script lang="ts" module>
  export interface FindTarget {
    /** Stable across redraws, so stepping does not lose its place when a row is drawn again. */
    readonly key: string;
    readonly text: string;
    /** Draws and unfolds the row if needed, and answers with it — or nothing if it is gone. */
    reveal(): Promise<HTMLElement | undefined>;
  }

  /** Where a needle sits in a haystack, every time. */
  export function hitsIn(text: string, needle: string): number[] {
    if (!needle) return [];
    const haystack = text.toLowerCase();
    const found: number[] = [];
    for (let from = 0; ; ) {
      const index = haystack.indexOf(needle, from);
      if (index < 0) return found;
      found.push(index);
      from = index + needle.length;
    }
  }

  /** The order to search in: the row he is on, then outward in both directions. */
  export function ring(length: number, anchor: number): number[] {
    const out: number[] = [];
    const start = Math.min(Math.max(0, anchor), Math.max(0, length - 1));
    for (let step = 0; out.length < length; step += 1) {
      if (start + step < length) out.push(start + step);
      if (step > 0 && start - step >= 0) out.push(start - step);
    }
    return out;
  }
</script>

<script lang="ts">
  import Icon from "../ui/Icon.svelte";

  /**
   * Find within the open conversation: ⌘F over the chat, matches marked where they are (CSS highlights, so the rows
   * themselves are never rewritten), enter and shift-enter stepping, "3 of 17", escape closing. It searches the data,
   * not the drawn rows: a match in a folded bubble or a collapsed run of tool calls is still a match, opened when it
   * is the one he stands on.
   */
  let {
    scope,
    targets,
    anchorKey,
    canLoadMore,
    loadMore,
  }: {
    scope: () => HTMLElement | undefined;
    targets: () => readonly FindTarget[];
    anchorKey: () => string | undefined;
    canLoadMore: () => boolean;
    loadMore: () => Promise<boolean>;
  } = $props();

  let shown = $state(false);
  let query = $state("");
  let input = $state<HTMLInputElement>();
  let hits = $state<{ key: string; nth: number }[]>([]);
  let at = $state(-1);
  const highlights = typeof CSS !== "undefined" && "highlights" in CSS;

  export const showing = () => shown;

  export function open() {
    if (shown) {
      input?.focus();
      input?.select();
      if (query.trim() && hits.length) void step(1);
      return;
    }
    shown = true;
    queueMicrotask(() => (input?.focus(), input?.select()));
    if (query.trim()) search(true);
  }

  export function close() {
    shown = false;
    hits = [];
    at = -1;
    unmark();
  }

  function search(jump: boolean) {
    const needle = query.trim().toLowerCase();
    unmark();
    if (!needle) return void ((hits = []), (at = -1));
    const list = targets();
    const order = ring(list.length, Math.max(0, list.findIndex((t) => t.key === anchorKey())));
    const found = new Map(list.map((t) => [t.key, hitsIn(t.text, needle).length]));
    hits = list.flatMap((t) => Array.from({ length: found.get(t.key) ?? 0 }, (_, nth) => ({ key: t.key, nth })));
    const nearest = order.find((i) => (found.get(list[i]!.key) ?? 0) > 0);
    at = nearest === undefined ? -1 : hits.findIndex((h) => h.key === list[nearest]!.key);
    if (jump && at >= 0) void show();
  }

  /** Steps, and pages further back when he walks off the oldest match. */
  export async function step(by: number) {
    if (!hits.length) return;
    if (at + by < 0 && canLoadMore()) {
      const here = hits[at];
      if (await loadMore()) {
        search(false);
        at = Math.max(0, (here ? hits.findIndex((h) => h.key === here.key && h.nth === here.nth) : 0) - 1);
        return void (await show());
      }
    }
    at = (at + by + hits.length) % hits.length;
    await show();
  }

  /** Puts him on the current match: the row drawn, unfolded, scrolled to, the occurrence marked. */
  async function show() {
    const hit = hits[at];
    const row = hit ? await targets().find((t) => t.key === hit.key)?.reveal() : undefined;
    if (!row || !hit) return;
    const ranges = mark(row);
    const current = ranges[hit.nth] ?? ranges[0];
    if (highlights && current) CSS.highlights.set("find-current", new Highlight(current));
    (current?.startContainer.parentElement ?? row).scrollIntoView({ block: "center", behavior: "smooth" });
  }

  /** Every occurrence in what is drawn, as highlights; answers with the ones inside `row`, in order. */
  function mark(row: HTMLElement): Range[] {
    unmark();
    const root = scope();
    const needle = query.trim().toLowerCase();
    if (!root || !needle || !highlights) return [];
    const all: Range[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode())
      for (const index of hitsIn(node.textContent ?? "", needle)) {
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + needle.length);
        all.push(range);
      }
    CSS.highlights.set("find-hit", new Highlight(...all));
    return all.filter((r) => row.contains(r.startContainer));
  }

  function unmark() {
    if (!highlights) return;
    CSS.highlights.delete("find-hit");
    CSS.highlights.delete("find-current");
  }

  const count = $derived(query.trim() ? (hits.length ? `${at + 1} of ${hits.length}${canLoadMore() ? "+" : ""}` : "no matches") : "");
</script>

<div class="find-bar" hidden={!shown}>
  <Icon name="search" size={13} />
  <input
    class="find-input"
    type="search"
    placeholder="Find in this conversation…"
    spellcheck="false"
    aria-label="Find in this conversation"
    bind:this={input}
    bind:value={query}
    oninput={() => search(true)}
    onkeydown={(event) => {
      if (event.key === "Escape") return close();
      if (event.key !== "Enter") return;
      event.preventDefault();
      void step(event.shiftKey ? -1 : 1);
    }}
  />
  <span class="find-count" class:none={Boolean(query.trim()) && !hits.length}>{count}</span>
  <button class="find-step" title="previous (⇧⏎)" aria-label="Previous" onclick={() => step(-1)}><Icon name="chevron" size={11} /></button>
  <button class="find-step next" title="next (⏎)" aria-label="Next" onclick={() => step(1)}><Icon name="chevron" size={11} /></button>
  <button class="find-close" title="close (esc)" aria-label="Close" onclick={close}><Icon name="x" size={12} /></button>
</div>
