/**
 * The thin bar along the top while something is on its way: every request to the daemon counts
 * in, the bar creeps towards the end while any is pending and completes when the last answers.
 * A navigation can hold it too (`begin`/`end`), so a view that is loading reads as loading.
 */
const TRICKLE_MS = 180;
/** A request that answers within this is never shown: the bar is for waits, not for every call. */
const DELAY_MS = 150;
const DONE_MS = 260;
/** How close to the end the bar creeps on its own; the last stretch is the real answer. */
const CEILING = 0.92;

const bar = () => document.querySelector<HTMLElement>("#progress");
let pending = 0;
let value = 0;
let timer: ReturnType<typeof setInterval> | undefined;
let hide: ReturnType<typeof setTimeout> | undefined;
let delay: ReturnType<typeof setTimeout> | undefined;

const paint = () => {
  const node = bar();
  if (!node) return;
  node.style.setProperty("--progress", String(value));
};

function start() {
  const node = bar();
  if (!node) return;
  clearTimeout(hide);
  node.classList.remove("done");
  node.classList.add("on");
  if (!value) value = 0.08;
  paint();
  timer ??= setInterval(() => {
    value = Math.min(CEILING, value + (CEILING - value) * 0.12);
    paint();
  }, TRICKLE_MS);
}

function finish() {
  const node = bar();
  clearInterval(timer);
  timer = undefined;
  value = 1;
  paint();
  node?.classList.add("done");
  hide = setTimeout(() => {
    node?.classList.remove("on", "done");
    value = 0;
    paint();
  }, DONE_MS);
}

export function begin() {
  pending += 1;
  if (pending === 1) delay = setTimeout(start, DELAY_MS);
}

export function end() {
  pending = Math.max(0, pending - 1);
  if (pending) return;
  clearTimeout(delay);
  if (timer) finish();
}

/** Runs `work` with the bar on; the bar ends with it whether it resolves or throws. */
export async function track<T>(work: Promise<T>): Promise<T> {
  begin();
  try {
    return await work;
  } finally {
    end();
  }
}
