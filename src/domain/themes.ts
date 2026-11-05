import { kv } from "../core/db.ts";

/**
 * The themes made in the web client's editor. The box holds them, so a theme made in one browser is there in the next.
 * Their contents are the client's business (it reads them back and checks each value before use); here they are
 * records under an id, written one at a time so two open browsers do not overwrite each other's themes.
 */

const KEY = "web_themes";
const ID = /^custom-[\w-]{1,64}$/;

export interface StoredTheme {
  readonly id: string;
  readonly name: string;
  readonly base: string;
  readonly [field: string]: unknown;
}

export class InvalidTheme extends Error {
  override readonly name = "InvalidTheme";
}

const all = (): Readonly<Record<string, StoredTheme>> => {
  try {
    return JSON.parse(kv.get(KEY) ?? "{}") as Record<string, StoredTheme>;
  } catch (error) {
    console.warn("[themes] stored themes do not parse", error);
    return {};
  }
};

export const list = (): readonly StoredTheme[] => Object.values(all());

export function put(id: string, theme: unknown): StoredTheme {
  if (!ID.test(id)) throw new InvalidTheme(`not a theme id: ${id}`);
  const { name, base } = (theme ?? {}) as Partial<StoredTheme>;
  if (typeof name !== "string" || typeof base !== "string") throw new InvalidTheme("a theme needs a name and a base palette");
  const stored = { ...(theme as StoredTheme), id };
  kv.set(KEY, JSON.stringify({ ...all(), [id]: stored }));
  return stored;
}

export function remove(id: string): boolean {
  const { [id]: gone, ...rest } = all();
  if (!gone) return false;
  kv.set(KEY, JSON.stringify(rest));
  return true;
}
