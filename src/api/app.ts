import { statSync } from "node:fs";
import { join, normalize } from "node:path";
import { config } from "../core/config.ts";

/** The client: the same bundle the desktop app runs, served to a browser at `/ui`. */
const root = join(config.repo, "desktop", "ui", "dist");

/**
 * The bundle's own files carried no cache headers, so a browser cached them by its own heuristics —
 * and cached each on its own schedule. A fresh `main.js` beside a stale `style.css` is how a map
 * card came out as a bare rule: the right elements with none of their styles. The html is never
 * cached and its asset links carry the running version, so the two halves of a release can only
 * ever arrive together.
 */
const BUST = /(\.\/(?:style\.css|main\.js|xterm\.css))(?:\?v=[^"']*)?/g;

/** The build's own stamp: the newest of the bundle's files, so a release changes it and nothing else does. */
function stamp() {
  let newest = 0;
  for (const name of ["main.js", "style.css", "index.html"]) {
    try {
      newest = Math.max(newest, statSync(join(root, name)).mtimeMs);
    } catch {
      /* a file that is not there cannot date the build */
    }
  }
  return Math.floor(newest).toString(36);
}

const html = async (file: Bun.BunFile) =>
  new Response((await file.text()).replace(BUST, `$1?v=${stamp()}`), {
    headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-cache" },
  });

/** A missing build is a deployment mistake worth saying out loud rather than a 404. */
export async function serveApp(pathname: string): Promise<Response> {
  const rest = pathname.slice("/ui".length).replace(/^\//, "");
  const resolved = join(root, normalize(rest || "index.html"));
  if (!resolved.startsWith(root)) return new Response("not found", { status: 404 });

  const file = Bun.file(resolved);
  if (await file.exists()) {
    if (resolved.endsWith(".html")) return await html(file);
    // Everything else is asked for with `?v=<version>`, so it may be held until the next release.
    return new Response(file, { headers: { "cache-control": "public, max-age=31536000, immutable" } });
  }

  // A route of the client's (`/ui/modules`) gets the app; the app's relative asset paths
  // need the route without a trailing slash, and a missing asset is a 404, not the app.
  if (rest.endsWith("/")) return Response.redirect(`/ui/${rest.replace(/\/+$/, "")}`, 302);
  if (/\.[a-z0-9]+$/i.test(rest.split("/").pop() ?? "")) return new Response("not found", { status: 404 });
  const index = Bun.file(join(root, "index.html"));
  if (await index.exists()) return await html(index);
  return new Response("not built; run `bun run build:ui`", { status: 503 });
}
