import { get, put } from "@vercel/blob";

const KEY = "builder/snapshot.json";

export interface Snapshot {
  ts: number;
  host: string;
  projects: { slug: string; summary: string }[];
  sessions: Record<string, unknown>[];
  recent: Record<string, unknown>[];
  events: Record<string, unknown>[];
}

/** Falls back to module memory when no blob store is attached, which is enough for `vite dev`. */
let memory: Snapshot | undefined;

const hasBlob = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN);

export async function write(snapshot: Snapshot) {
  memory = snapshot;
  if (!hasBlob()) return;
  await put(KEY, JSON.stringify(snapshot), {
    access: "private",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 0,
  });
}

export async function read(): Promise<Snapshot | undefined> {
  if (!hasBlob()) return memory;
  try {
    const result = await get(KEY, { access: "private" });
    if (result?.statusCode !== 200) return memory;
    return (await new Response(result.stream).json()) as Snapshot;
  } catch {
    return memory;
  }
}
