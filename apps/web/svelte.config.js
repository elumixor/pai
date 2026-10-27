import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/**
 * The daemon owns every path of its origin for the API (`/messages`, `/tasks`, …), so the client lives at `/` and
 * keeps its own routes in the hash: `/#/tasks` can never be mistaken for `GET /tasks`.
 */
/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({ pages: "build", assets: "build" }),
    router: { type: "hash" },
    alias: { $protocol: "../../src/protocol" },
  },
};

export default config;
