import { join, normalize } from "node:path";
import { config } from "../core/config.ts";

const root = join(config.repo, "app", "dist");

/**
 * The web app the daemon serves over the tailnet. It is built into `app/dist`; a missing
 * build is a deployment mistake worth saying out loud rather than a 404.
 */
export async function serveApp(pathname: string): Promise<Response> {
  const relative = pathname === "/app" || pathname === "/app/" ? "index.html" : pathname.slice("/app/".length);
  const resolved = join(root, normalize(relative));
  if (!resolved.startsWith(root)) return new Response("not found", { status: 404 });

  const file = Bun.file(resolved);
  if (await file.exists()) return new Response(file);

  const index = Bun.file(join(root, "index.html"));
  if (await index.exists()) return new Response(index);
  return new Response("the web app is not built; run `bun run build:app`", { status: 503 });
}
