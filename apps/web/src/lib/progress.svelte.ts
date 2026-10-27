/**
 * The thin bar along the top while something is on its way: every request to the daemon counts in, the bar creeps
 * towards the end while any is pending and completes when the last answers. A request that answers within
 * `DELAY_MS` is never shown: the bar is for waits, not for every call.
 */
const TRICKLE_MS = 180;
const DELAY_MS = 150;
const DONE_MS = 260;
/** How close to the end the bar creeps on its own; the last stretch is the real answer. */
const CEILING = 0.92;

class Progress {
  value = $state(0);
  on = $state(false);
  done = $state(false);
  #pending = 0;
  #timer: ReturnType<typeof setInterval> | undefined;
  #delay: ReturnType<typeof setTimeout> | undefined;
  #hide: ReturnType<typeof setTimeout> | undefined;

  begin() {
    this.#pending += 1;
    if (this.#pending === 1) this.#delay = setTimeout(() => this.#start(), DELAY_MS);
  }

  end() {
    this.#pending = Math.max(0, this.#pending - 1);
    if (this.#pending) return;
    clearTimeout(this.#delay);
    if (this.#timer) this.#finish();
  }

  #start() {
    clearTimeout(this.#hide);
    this.done = false;
    this.on = true;
    if (!this.value) this.value = 0.08;
    this.#timer ??= setInterval(() => (this.value = Math.min(CEILING, this.value + (CEILING - this.value) * 0.12)), TRICKLE_MS);
  }

  #finish() {
    clearInterval(this.#timer);
    this.#timer = undefined;
    this.value = 1;
    this.done = true;
    this.#hide = setTimeout(() => {
      this.on = false;
      this.done = false;
      this.value = 0;
    }, DONE_MS);
  }
}

export const progress = new Progress();

/** Runs `work` with the bar on; the bar ends with it whether it resolves or throws. */
export async function track<T>(work: Promise<T>): Promise<T> {
  progress.begin();
  try {
    return await work;
  } finally {
    progress.end();
  }
}
