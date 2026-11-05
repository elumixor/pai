import type { PaiConfig } from "./src/connectors/source.ts";

/**
 * The connectors repository, cloned as `modules/`. `pai.config.local.ts` (not committed) overrides a key, usually `repo`
 * with a path to a checkout. `connectors` is what is on at the very first start and the order the clients show them;
 * after that the user connects and disconnects from settings. dev is not a connector: it is a separate system pai talks
 * to (`src/domain/dev.ts`).
 */
export default {
  repo: "github:elumixor/desk-connectors",
  connectors: ["telegram", "email", "whatsapp", "browser"],
} satisfies PaiConfig;
