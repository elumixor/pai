import type { PaiConfig } from "./src/modules/sdk.ts";

/**
 * The modules this pai is made of, each its own repository, installed under `modules/`.
 * `pai.config.local.ts` (not committed) overrides an entry with a path while working on one.
 */
export default {
  modules: {
    browser: "github:elumixor/pai-browser",
    builder: "github:elumixor/pai-builder",
    telegram: "github:elumixor/pai-telegram",
    linkedin: "github:elumixor/pai-linkedin",
    whatsapp: "github:elumixor/pai-whatsapp",
  },
} satisfies PaiConfig;
