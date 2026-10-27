import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

/** The API paths of the daemon, proxied in dev; the client's own routes are in the hash and never reach it. */
const API = /^\/(?!@|_app|src|node_modules|\.svelte-kit)[^./][^.]*$/;

/**
 * `bun run dev` talks to the box: its https address and token are what `pai` learned over ssh into
 * `~/.config/pai/box.json`. `PAI_DEV_API` points it anywhere else.
 */
function box() {
  if (process.env.PAI_DEV_API) return { url: process.env.PAI_DEV_API, token: process.env.PAI_DEV_TOKEN ?? "" };
  const file = join(homedir(), ".config", "pai", "box.json");
  const known = JSON.parse(readFileSync(file, "utf8")) as { url?: string; baseUrl?: string; token?: string };
  const url = known.url ?? known.baseUrl;
  if (!url) throw new Error(`${file} has no url — run any \`pai\` command once to learn the box`);
  return { url, token: known.token ?? "" };
}

export default defineConfig(({ command }) => {
  const target = command === "serve" ? box() : null;
  return {
    plugins: [tailwindcss(), sveltekit()],
    server: target
      ? {
          port: 5180,
          proxy: {
            [API.source]: {
              target: target.url,
              changeOrigin: true,
              headers: target.token ? { authorization: `Bearer ${target.token}` } : {},
            },
          },
        }
      : undefined,
  };
});
