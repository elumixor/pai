import { join, normalize } from "node:path";
import { config } from "../core/config.ts";

const roots = {
  /** The dashboard: what the daemon itself is doing. */
  app: join(config.repo, "app", "dist"),
  /** The client: the same bundle the desktop app runs, served to a browser. */
  ui: join(config.repo, "desktop", "ui", "dist"),
};

/**
 * The web app the daemon serves over the tailnet. It is built into `app/dist`; a missing
 * build is a deployment mistake worth saying out loud rather than a 404.
 */
export async function serveApp(pathname: string): Promise<Response> {
  const which = pathname.startsWith("/ui") ? "ui" : "app";
  const root = roots[which];
  const rest = pathname.slice(`/${which}`.length).replace(/^\//, "");
  const resolved = join(root, normalize(rest || "index.html"));
  if (!resolved.startsWith(root)) return new Response("not found", { status: 404 });

  const file = Bun.file(resolved);
  if (await file.exists()) return new Response(file);

  const index = Bun.file(join(root, "index.html"));
  if (await index.exists()) return new Response(index);
  return new Response(`not built; run \`bun run ${which === "ui" ? "build:ui" : "build:app"}\``, { status: 503 });
}
