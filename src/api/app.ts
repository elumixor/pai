import { join, normalize } from "node:path";
import { config } from "../core/config.ts";

/** The client: the same bundle the desktop app runs, served to a browser at `/ui`. */
const root = join(config.repo, "desktop", "ui", "dist");

/** A missing build is a deployment mistake worth saying out loud rather than a 404. */
export async function serveApp(pathname: string): Promise<Response> {
  const rest = pathname.slice("/ui".length).replace(/^\//, "");
  const resolved = join(root, normalize(rest || "index.html"));
  if (!resolved.startsWith(root)) return new Response("not found", { status: 404 });

  const file = Bun.file(resolved);
  if (await file.exists()) return new Response(file);

  const index = Bun.file(join(root, "index.html"));
  if (await index.exists()) return new Response(index);
  return new Response("not built; run `bun run build:ui`", { status: 503 });
}
