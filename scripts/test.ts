// Each test file gets its own process: the daemon reads its configuration once at import,
// so files that point it at different scratch directories cannot share an interpreter.
import { Glob } from "bun";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const files = (await Array.fromAsync(new Glob("{src,test}/**/*.test.ts").scan("."))).sort();
if (files.length === 0) throw new Error("no test files found");

// Anything that reaches the database or the settings file gets a scratch copy, so a suite
// that does not set its own never touches the daemon's live data — a lock on the real
// database killed a turn once.
const scratch = mkdtempSync(join(tmpdir(), "pai-test-"));
const env = {
  ...process.env,
  PAI_DB: process.env.PAI_DB ?? join(scratch, "pai.db"),
  PAI_CONFIG: process.env.PAI_CONFIG ?? join(scratch, "config.json"),
};

let failed = 0;
for (const file of files) {
  const result = Bun.spawnSync({ cmd: ["bun", "test", file], env, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) failed += 1;
}

if (failed > 0) {
  console.error(`\n${failed} of ${files.length} test files failed`);
  process.exit(1);
}
console.log(`\n${files.length} test files passed`);
