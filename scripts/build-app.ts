// The web app is served by the daemon itself, so it is built into `app/dist` on install
// and on every update rather than deployed anywhere.
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { config } from "../src/core/config.ts";

const source = join(config.repo, "app");
const out = join(source, "dist");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const result = await Bun.build({ entrypoints: [join(source, "main.ts")], outdir: out, minify: true });
if (!result.success) throw new AggregateError(result.logs, "web app build failed");

for (const file of ["index.html", "style.css"]) cpSync(join(source, file), join(out, file));
cpSync(join(config.repo, "node_modules", "@xterm", "xterm", "css", "xterm.css"), join(out, "xterm.css"));

console.log(`built ${out}`);
