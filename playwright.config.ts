import { defineConfig } from "@playwright/test";

/** The web client against the daemon on a scratch database (`test/web/server.ts`). `bun run test:web`. */
export default defineConfig({
  testDir: "test/web",
  testMatch: "*.spec.ts",
  workers: 1,
  timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:8898", trace: "retain-on-failure" },
  webServer: { command: "bun test/web/server.ts", url: "http://127.0.0.1:8898/health", reuseExistingServer: false },
});
