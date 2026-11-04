import type { PaiConfig } from "./src/connectors/source.ts";

/**
 * The connectors this pai runs, all from one repository cloned as `modules/`. `pai.config.local.ts` (not committed)
 * overrides a key, usually `repo` with a path to a checkout. The order is the one the clients show; they start in it
 * too, after what each `requires`. linkedin is left out for now: it needs a proxy, and once listed it says so and offers to set one up. dev is not a connector: it is a
 * separate system pai talks to (`src/domain/dev.ts`).
 */
export default {
  repo: "github:elumixor/desk-connectors",
  connectors: ["telegram", "email", "whatsapp", "browser"],
} satisfies PaiConfig;
