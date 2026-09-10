// Each test file gets its own process: the daemon reads its configuration once at import,
// so files that point it at different scratch directories cannot share an interpreter.
import { Glob } from "bun";

const files = (await Array.fromAsync(new Glob("{src,test}/**/*.test.ts").scan("."))).sort();
if (files.length === 0) throw new Error("no test files found");

let failed = 0;
for (const file of files) {
  const result = Bun.spawnSync({ cmd: ["bun", "test", file], stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) failed += 1;
}

if (failed > 0) {
  console.error(`\n${failed} of ${files.length} test files failed`);
  process.exit(1);
}
console.log(`\n${files.length} test files passed`);
