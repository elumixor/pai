const LIFETIME_MS = 5000;

/** Short messages in the corner: a send that failed, an answer that did not land. */
class Notices {
  list = $state<{ id: number; text: string }[]>([]);
  #next = 0;

  error(error: unknown) {
    const notice = { id: this.#next++, text: error instanceof Error ? error.message : String(error) };
    this.list = [...this.list, notice];
    setTimeout(() => (this.list = this.list.filter((n) => n.id !== notice.id)), LIFETIME_MS);
  }
}

export const notices = new Notices();
