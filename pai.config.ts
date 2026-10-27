import type { PaiConfig } from "./src/connectors/loader.ts";

/**
 * The connectors this pai runs, each its own repository implementing `@desk/connector`, installed under `modules/`.
 * `pai.config.local.ts` (not committed) overrides an entry with a path while working on one. The order here is the
 * order the clients show them; they start in it too, after what each `requires`. dev is not a connector: it is a
 * separate system pai talks to (`src/domain/dev.ts`).
 */
export default {
  connectors: {
    telegram: "github:elumixor/desk-telegram",
    email: "github:elumixor/desk-email",
    linkedin: "github:elumixor/desk-linkedin",
    whatsapp: "github:elumixor/desk-whatsapp",
    browser: "github:elumixor/desk-browser",
  },
} satisfies PaiConfig;
