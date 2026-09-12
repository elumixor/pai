/**
 * `bun run editor` — the browser editor, in one command.
 *
 * Builds and installs the pai extension, then serves code-server (VS Code in a browser) over
 * the project root. code-server is installed if it is missing; the extension is pointed at
 * the daemon so threads, projects and terminals are there when the editor opens.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "../src/core/config.ts";

const extension = join(config.repo, "editor", "vscode");
const vsix = join(extension, "pai.vsix");
const port = Number(process.env.PAI_EDITOR_PORT ?? 8788);
const bind = process.env.PAI_EDITOR_BIND ?? "127.0.0.1";
const daemon = config.baseUrl || `http://127.0.0.1:${config.port}`;

async function run(cmd: string[], cwd = config.repo) {
  const proc = Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) throw new Error(`${cmd.join(" ")} failed`);
}

async function which(binary: string) {
  return (await Bun.$`command -v ${binary}`.quiet().nothrow()).exitCode === 0;
}

/** Homebrew on macOS, the upstream installer everywhere else. Both put `code-server` on PATH. */
async function installCodeServer() {
  console.log("installing code-server…");
  if (process.platform === "darwin" && (await which("brew"))) await run(["brew", "install", "code-server"]);
  else await run(["sh", "-c", "curl -fsSL https://code-server.dev/install.sh | sh"]);
}

/** The extension reaches the daemon through settings, so a fresh editor needs no configuration. */
async function settings() {
  const path = join(homedir(), ".local", "share", "code-server", "User", "settings.json");
  await mkdir(join(path, ".."), { recursive: true });
  const current = existsSync(path) ? (JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>) : {};
  await writeFile(path, JSON.stringify({ ...current, "pai.baseUrl": daemon }, null, 2));
}

if (!existsSync(join(extension, "node_modules"))) await run(["bun", "install"], extension);
await run(["bun", "run", "build"], extension);
await run(["bunx", "@vscode/vsce", "package", "--no-dependencies", "-o", "pai.vsix"], extension);
if (!(await which("code-server"))) await installCodeServer();
await run(["code-server", "--install-extension", vsix, "--force"]);
await settings();

console.log(`\neditor  http://${bind === "0.0.0.0" ? "127.0.0.1" : bind}:${port}`);
console.log(`daemon  ${daemon}`);
console.log(`dashboard  ${daemon}/app\n`);

await run([
  "code-server",
  "--bind-addr",
  `${bind}:${port}`,
  "--auth",
  process.env.PAI_EDITOR_PASSWORD ? "password" : "none",
  "--disable-telemetry",
  config.devRoot,
]);
