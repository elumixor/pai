import type { PaiConfig } from "./src/modules/sdk.ts";

/**
 * The modules this pai is made of, each its own repository, installed under `modules/`.
 * `pai.config.local.ts` (not committed) overrides an entry with a path while working on one.
 * The order here is the order the clients show them: the connectors, then the capabilities. Modules start in this
 * order too (after what each `requires`): `dev` stays last, so the chat is listening when it announces terminal threads.
 */
export default {
  modules: {
    telegram: "github:elumixor/pai-telegram",
    email: "github:elumixor/pai-email",
    linkedin: "github:elumixor/pai-linkedin",
    whatsapp: "github:elumixor/pai-whatsapp",
    browser: "github:elumixor/pai-browser",
    dev: "github:elumixor/pai-dev",
  },
} satisfies PaiConfig;
