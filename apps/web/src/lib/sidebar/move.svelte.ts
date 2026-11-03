/** The rows `m` (or "Move into…") is moving: the picker of where to is open while there are some. */
class Mover {
  ids = $state<readonly string[]>([]);
  open = $state(false);

  start(ids: readonly string[]) {
    if (!ids.length) return;
    this.ids = ids;
    this.open = true;
  }
}

export const mover = new Mover();
