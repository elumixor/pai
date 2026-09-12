/** Bundles the extension for the VS Code extension host: CommonJS, Node, `vscode` stays external. */
const result = await Bun.build({
  entrypoints: ["src/extension.ts"],
  outdir: "out",
  target: "node",
  format: "cjs",
  external: ["vscode"],
  minify: process.argv.includes("--minify"),
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log("out/extension.js");

export {};
