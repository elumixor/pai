import { get, send } from "../api";
import { live } from "./live.svelte";

/** A row of Pai's inbox (`GET /inbox`): what came in, and what Pai did with it. */
export interface InboxEntry {
  readonly id: string;
  readonly source: string;
  readonly kind: string;
  readonly title: string;
  readonly body: string;
  readonly link: string | null;
  readonly at: number;
  readonly action: "pending" | "ignored" | "muted" | "filed" | "woke" | "told" | "routed" | "failed";
  /** `main`, `agent:<slug>`, `thread:<session id>` or `task:<id>`. */
  readonly target: string | null;
  readonly note: string | null;
  readonly readAt: number | null;
}

export type InboxFilter = "relevant" | "all";

/** Pai's inbox, read from the box and re-read when it says a row changed. */
class Inbox {
  items = $state.raw<readonly InboxEntry[]>([]);
  unread = $state(0);
  filter = $state<InboxFilter>("relevant");
  #started = false;
  #timer: ReturnType<typeof setTimeout> | undefined;

  start() {
    if (this.#started) return;
    this.#started = true;
    live.on((event) => {
      if (event.kind !== "inbox.changed") return;
      // A burst of triage decisions is one re-read.
      clearTimeout(this.#timer);
      this.#timer = setTimeout(() => void this.load(), 300);
    });
    live.onReconnect(() => void this.load());
    void this.load();
  }

  async load() {
    const filter = this.filter;
    const found = await get<{ items: InboxEntry[]; unread: number }>(`/inbox?filter=${filter}`, true).catch(() => null);
    if (!found || filter !== this.filter) return;
    this.items = found.items;
    this.unread = found.unread;
  }

  show(filter: InboxFilter) {
    this.filter = filter;
    void this.load();
  }

  async read(ids?: readonly string[]) {
    const at = Date.now();
    this.items = this.items.map((e) => (!ids || ids.includes(e.id) ? { ...e, readAt: e.readAt ?? at } : e));
    const { data } = await send<{ unread: number }>("/inbox/read", ids ? { ids } : {});
    if (data) this.unread = data.unread;
  }
}

export const inbox = new Inbox();
