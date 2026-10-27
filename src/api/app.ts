import { join, normalize } from "node:path";
import { config } from "../core/config.ts";

/** The web client (`apps/web`), served at `/`: its routes are in the hash, so every other path stays the API's. */
const root = join(config.repo, "apps", "web", "build");

/**
 * The html is never cached and everything under `/_app/immutable/` is content-hashed, so a release can only
 * arrive whole: a fresh page always names fresh assets. (Assets with no hash, like the icon, are revalidated.)
 */
const IMMUTABLE = /^\/_app\/immutable\//;

/** A missing build is a deployment mistake worth saying out loud rather than a 404. */
export async function serveApp(pathname: string): Promise<Response> {
  const resolved = join(root, normalize(pathname === "/" ? "index.html" : pathname));
  if (!resolved.startsWith(root)) return new Response("not found", { status: 404 });
  const file = Bun.file(resolved);
  if (!(await file.exists())) {
    return pathname === "/" ? new Response("not built; run `bun run build:web`", { status: 503 }) : new Response("not found", { status: 404 });
  }
  const cache = IMMUTABLE.test(pathname) ? "public, max-age=31536000, immutable" : "no-cache";
  const type = resolved.endsWith(".html") ? { "content-type": "text/html;charset=utf-8" } : {};
  return new Response(file, { headers: { "cache-control": cache, ...type } });
}

export const isAppPath = (pathname: string) => pathname === "/" || pathname.startsWith("/_app/") || pathname === "/favicon.svg";
