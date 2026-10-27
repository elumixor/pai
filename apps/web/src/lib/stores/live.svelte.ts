import { follow } from "../events";
import type { PaiEvent } from "../types";

type Listener = (event: PaiEvent) => void;

/** One event stream for the whole app; views subscribe to what they care about. */
class Live {
  connected = $state(false);
  #listeners = new Set<Listener>();
  #reconnectListeners = new Set<() => void>();
  #stop: (() => void) | null = null;

  start() {
    if (this.#stop) return;
    this.#stop = follow(
      { deltas: "1", replay: "0" },
      (event) => {
        this.connected = true;
        for (const listener of this.#listeners) listener(event);
      },
      () => {
        for (const listener of this.#reconnectListeners) listener();
      },
    );
    this.connected = true;
  }

  on(listener: Listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onReconnect(listener: () => void) {
    this.#reconnectListeners.add(listener);
    return () => this.#reconnectListeners.delete(listener);
  }
}

export const live = new Live();
