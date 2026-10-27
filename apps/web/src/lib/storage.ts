/**
 * Writes to the browser's storage that never fail the caller: a full or missing store means the setting lasts the
 * session, which is nothing worth an error over.
 */
export function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch (error) {
    console.warn(`[storage] could not keep ${key}`, error);
  }
}

export function forget(key: string) {
  try {
    localStorage.removeItem(key);
  } catch (error) {
    console.warn(`[storage] could not drop ${key}`, error);
  }
}

/** A stored JSON value, or the fallback when there is none or it does not parse. */
export function recall<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? ({ ...(typeof fallback === "object" && !Array.isArray(fallback) ? fallback : {}), ...JSON.parse(raw) } as T) : fallback;
  } catch {
    return fallback;
  }
}

export function recallRaw(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
