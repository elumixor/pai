// Each test file gets its own process: the daemon reads its configuration once at import,
// so files that point it at different scratch directories cannot share an interpreter.
import { Glob } from "bun";
import { existsSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = (await Array.fromAsync(new Glob("{src,test}/**/*.test.ts").scan("."))).sort();
// The modules are part of this pai (`pai.config.ts`), so their suites run with it — a module
// is where the tools that act in the world live, and an untested one is where a send that
// never happened gets reported as a send. `followSymlinks`: a module being worked on is a
// link to its own checkout.
// A glob that follows the links would walk every module's node_modules; this walk skips them.
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isFile() ? entry.name.endsWith(".test.ts") : false) out.push(path);
    else if (entry.isDirectory() || (entry.isSymbolicLink() && statSync(path).isDirectory())) out.push(...walk(path));
  }
  return out;
}
// Only the configured ones: a module left on disk but switched off in `pai.config.ts` is not part of this pai.
const configured = Object.keys((await import("../pai.config.ts")).default.connectors);
const inModules = configured.flatMap((name) => (existsSync(join("modules", name)) ? walk(join("modules", name)) : [])).sort();
const files = [...here, ...inModules];
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
