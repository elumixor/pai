import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../core/config.ts";

/**
 * Images people attach, kept by content hash next to the database, so a transcript can point at
 * one and a client can show it (`GET /attachments/<name>`). A message that reaches a terminal as
 * text carries its pictures as `[image: …/attachments/<name>]`, a copy the channel saved there.
 */

export interface Image {
  readonly media_type: string;
  readonly data: string;
}

const dir = join(dirname(config.dbPath), "attachments");
const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const NAME = /^[0-9a-f]{16}\.(png|jpg|gif|webp|bin)$/;

/** `[image: /Users/…/attachments/<name>]` — how a message delivered as text points at its picture. */
export const IMAGE_REF = /\n?\[image: [^\]\n]*?attachments\/([0-9a-f]{16}\.\w+)\]/g;

/** The file name an image is kept under, written the first time it is seen. */
export function keep(image: Image): string {
  const name = `${createHash("sha256").update(image.data).digest("hex").slice(0, 16)}.${EXTENSIONS[image.media_type] ?? "bin"}`;
  const path = join(dir, name);
  if (!existsSync(path)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, Buffer.from(image.data, "base64"));
  }
  return name;
}

/** A kept image as a response, or undefined for a name that is not one. */
export function serve(name: string): Response | undefined {
  if (!NAME.test(name)) return undefined;
  const path = join(dir, name);
  if (!existsSync(path)) return undefined;
  return new Response(Bun.file(path), { headers: { "content-type": TYPES[name.split(".")[1]!] ?? "application/octet-stream", "cache-control": "private, max-age=31536000, immutable" } });
}
