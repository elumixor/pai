/**
 * Writes to the browser's storage that do not fail the caller. The offline cache of GET responses
 * is the one thing in it that grows; when a write hits the quota, that cache is dropped (it is
 * only a stand-in until the daemon answers) and the write tried once more. A write that still
 * fails is let go: nothing here is worth more than the click that caused it.
 */
export const CACHE_PREFIX = "pai.cache:";

export function evictCache() {
  for (const key of Object.keys(localStorage)) if (key.startsWith(CACHE_PREFIX)) localStorage.removeItem(key);
}

export function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    try {
      evictCache();
      localStorage.setItem(key, value);
    } catch {
      /* no room, or no storage at all: the setting lasts the session */
    }
  }
}
