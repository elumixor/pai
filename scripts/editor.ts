#!/usr/bin/env bun
/**
 * `bun run editor` — the browser editor on its own, without the daemon around it.
 *
 * The daemon already starts and supervises code-server (`src/domain/editor.ts`), so this is
 * for working on the extension: it builds it, links it into code-server and serves the
 * editor in the foreground.
 */
import { config } from "../src/core/config.ts";
import { editorUrl, startEditor } from "../src/domain/editor.ts";

const stop = startEditor();
const daemon = config.baseUrl || `http://127.0.0.1:${config.port}`;
console.log(`\neditor     ${editorUrl()}`);
console.log(`daemon     ${daemon}`);
console.log(`dashboard  ${daemon}/app\n`);

process.on("SIGINT", () => {
  stop();
  process.exit(0);
});
