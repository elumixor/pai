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

/**
 * A stored JSON value, or the fallback when there is none, it does not parse or it is not the fallback's shape. An
 * object is laid over the fallback, so a setting added later has its default; an array or a scalar is taken as it is.
 */
export function recall<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(fallback)) return (Array.isArray(parsed) ? parsed : fallback) as T;
    if (fallback && typeof fallback === "object") return (parsed && typeof parsed === "object" && !Array.isArray(parsed) ? { ...fallback, ...parsed } : fallback) as T;
    return (parsed ?? fallback) as T;
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
