/**
 * Drafts that survive a reload, pictures included. Text alone would fit in localStorage, but an
 * attached image is base64 and megabytes of it do not — so a draft lives in IndexedDB, one record
 * per chat, holding the parts of the box in the order he typed them. Over the cap the oldest
 * drafts go rather than the write failing: a draft is worth keeping, never worth an error.
 */

/** One piece of the box: a run of text, a pasted chunk, or an image. */
export type DraftPart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "paste"; readonly text: string }
  | { readonly kind: "image"; readonly media_type: string; readonly data: string; readonly preview: string };

interface Draft {
  readonly key: string;
  readonly parts: readonly DraftPart[];
  readonly at: number;
}

const DB = "pai";
const STORE = "drafts";
/** Roughly a handful of screenshots; past it the oldest chats' drafts are dropped. */
const CAP_BYTES = 24 * 1024 * 1024;

let opening: Promise<IDBDatabase | undefined> | undefined;
function open(): Promise<IDBDatabase | undefined> {
  opening ??= new Promise<IDBDatabase | undefined>((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(undefined);
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(undefined);
  });
  return opening;
}

const done = <T>(request: IDBRequest<T>) =>
  new Promise<T | undefined>((resolve) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(undefined);
  });

const size = (d: Draft) => d.parts.reduce((n, p) => n + (p.kind === "image" ? p.data.length : p.text.length), 0);

export async function saveDraft(key: string, parts: readonly DraftPart[]) {
  const db = await open();
  if (!db) return;
  if (!parts.length) return clearDraft(key);
  const store = db.transaction(STORE, "readwrite").objectStore(STORE);
  await done(store.put({ key, parts, at: Date.now() } satisfies Draft));
  await trim();
}

export async function loadDraft(key: string): Promise<readonly DraftPart[]> {
  const db = await open();
  if (!db) return [];
  const found = await done(db.transaction(STORE, "readonly").objectStore(STORE).get(key) as IDBRequest<Draft | undefined>);
  return found?.parts ?? [];
}

export async function clearDraft(key: string) {
  const db = await open();
  if (!db) return;
  await done(db.transaction(STORE, "readwrite").objectStore(STORE).delete(key));
}

/** Newest drafts stay; the oldest go until what is kept fits the cap. */
async function trim() {
  const db = await open();
  if (!db) return;
  const all = (await done(db.transaction(STORE, "readonly").objectStore(STORE).getAll() as IDBRequest<Draft[]>)) ?? [];
  let total = all.reduce((n, d) => n + size(d), 0);
  if (total <= CAP_BYTES) return;
  const store = db.transaction(STORE, "readwrite").objectStore(STORE);
  for (const old of [...all].sort((a, b) => a.at - b.at)) {
    if (total <= CAP_BYTES) break;
    total -= size(old);
    await done(store.delete(old.key));
  }
}
