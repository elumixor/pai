import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../core/config.ts";

/**
 * What people attach, kept by content hash next to the database: a client shows it
 * (`GET /attachments/<name>`) and a session opens it by path. Pictures go to the model as pictures;
 * everything else — a PDF above all — goes as the path of a file it can open with the Read tool,
 * with its real name and size in the line, because "a file is at /data/ab12.pdf" tells a model
 * nothing about what it is.
 *
 * The limits are decided here rather than left to whatever the transport happens to allow, and a
 * file the model could not read is refused when it is attached, not halfway through a turn.
 */

export interface Image {
  readonly media_type: string;
  readonly data: string;
}

/** A file as a client hands it over: base64, with the name he knows it by. */
export interface Upload extends Image {
  readonly name?: string;
}

/** One kept file, as a row remembers it: the hash name on disk, his name, and how big it is. */
export interface Kept {
  readonly file: string;
  readonly name: string;
  readonly size: number;
  readonly media_type: string;
}

const dir = join(dirname(config.dbPath), "attachments");

/** Big enough for a scanned contract, small enough that a turn does not choke on it. */
export const MAX_BYTES = 25 * 1024 * 1024;
/** More than this in one message is a folder, and a folder belongs in the repo, not in a chat. */
export const MAX_FILES = 8;

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "text/html": "html",
  "application/json": "json",
  "application/xml": "xml",
  "text/xml": "xml",
  "application/x-yaml": "yaml",
  "text/yaml": "yaml",
};
const TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  html: "text/html",
  json: "application/json",
  xml: "application/xml",
  yaml: "application/x-yaml",
  log: "text/plain",
  ts: "text/plain",
  js: "text/plain",
  py: "text/plain",
  sh: "text/plain",
};
const NAME = /^[0-9a-f]{16}\.[a-z0-9]{1,8}$/;

export const isImage = (type: string) => type.startsWith("image/");

/**
 * Whether the model can make anything of it. A PDF and anything textual it reads with the Read
 * tool; a picture it sees. An archive, a spreadsheet binary or an executable it cannot, and saying
 * so at attach time is the whole point — the alternative is a turn that opens it and gives up.
 */
export function readable(upload: Upload): string | undefined {
  const type = (upload.media_type || "").toLowerCase();
  const extension = (upload.name?.split(".").pop() ?? "").toLowerCase();
  const bytes = Math.floor((upload.data.length * 3) / 4);
  if (bytes > MAX_BYTES) return `${upload.name ?? "the file"} is ${mb(bytes)}, over the ${mb(MAX_BYTES)} limit`;
  if (!upload.data) return `${upload.name ?? "the file"} is empty`;
  if (isImage(type)) return type in EXTENSIONS ? undefined : `${type} is an image kind nothing here can show`;
  if (type.startsWith("text/") || type in EXTENSIONS || extension in TYPES) return undefined;
  // Unknown type, unknown extension: it may well be fine, but nothing can promise the model reads it.
  return `${upload.name ?? "that file"} is ${type || "of an unknown kind"}, which the model cannot read — put it in a repo and say where`;
}

export const mb = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** `[image: …/attachments/<name>]` — how a message delivered as text points at its picture. */
export const IMAGE_REF = /\n?\[image: [^\]\n]*?attachments\/([0-9a-f]{16}\.\w+)\]/g;

const extensionFor = (upload: Upload) => {
  const fromType = EXTENSIONS[(upload.media_type || "").toLowerCase()];
  if (fromType) return fromType;
  const own = (upload.name?.split(".").pop() ?? "").toLowerCase();
  return own && /^[a-z0-9]{1,8}$/.test(own) ? own : "bin";
};

/** The file name an upload is kept under, written the first time it is seen. */
export function keep(upload: Upload): string {
  const name = `${createHash("sha256").update(upload.data).digest("hex").slice(0, 16)}.${extensionFor(upload)}`;
  const path = join(dir, name);
  if (!existsSync(path)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, Buffer.from(upload.data, "base64"));
  }
  return name;
}

/** Where a kept file lives, for a session that can open it itself. */
export const pathOf = (name: string) => join(dir, name);

/** What is known about a kept file: his name for it when a row remembered one, and its size. */
export function kept(name: string, given?: string): Kept {
  const path = pathOf(name);
  const size = existsSync(path) ? statSync(path).size : 0;
  return { file: name, name: given || name, size, media_type: TYPES[name.split(".").pop() ?? ""] ?? "application/octet-stream" };
}

/**
 * Attachments on their way into a message: each kept once, the row remembering what they are (which
 * is what a client draws and links to) and the turn getting the pictures themselves plus a line per
 * file naming it, its size and the path to open.
 */
export function attach(uploads: readonly Upload[] | undefined) {
  const list = (uploads ?? []).slice(0, MAX_FILES);
  const images: Upload[] = [];
  const names: string[] = [];
  const files: Kept[] = [];
  for (const upload of list) {
    const name = keep(upload);
    if (isImage(upload.media_type)) {
      images.push(upload);
      names.push(name);
      continue;
    }
    files.push({ ...kept(name, upload.name), media_type: upload.media_type || TYPES[name.split(".").pop() ?? ""] || "application/octet-stream" });
  }
  const imageRefs = names.map((n) => `[image: ${pathOf(n)}]`).join("\n");
  // Named and sized, with the path: this is the line a model opens with the Read tool.
  const fileRefs = files.map((f) => `[file: ${f.name}, ${mb(f.size)} — read it at ${pathOf(f.file)}]`).join("\n");
  return {
    names,
    files,
    images,
    meta: names.length || files.length ? { ...(names.length ? { images: names } : {}), ...(files.length ? { files } : {}) } : undefined,
    /** Everything, for a turn that is delivered as text (a terminal, an agent's wake). */
    refs: [imageRefs, fileRefs].filter(Boolean).join("\n"),
    fileRefs,
  };
}

/** A kept file as a response, or undefined for a name that is not one. */
export function serve(name: string, given?: string): Response | undefined {
  if (!NAME.test(name)) return undefined;
  const path = pathOf(name);
  if (!existsSync(path)) return undefined;
  const type = TYPES[name.split(".").pop() ?? ""] ?? "application/octet-stream";
  const headers: Record<string, string> = { "content-type": type, "cache-control": "private, max-age=31536000, immutable" };
  // A file he downloads should arrive under the name he knows, not under its hash.
  if (given) headers["content-disposition"] = `inline; filename="${given.replace(/[^\w.() -]+/g, "_")}"`;
  return new Response(Bun.file(path), { headers });
}
