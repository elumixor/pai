#!/usr/bin/env bun
/**
 * `bun run editor` — VS Code in a browser, with the pai extension already in it.
 *
 * It builds and installs the extension, installs code-server if the machine has none, then
 * serves the editor over the project root. `--install` instead leaves a systemd --user
 * service behind, which is how the box serves the editor to any browser on the tailnet
 * without anything running locally; `--uninstall` removes it.
 */
import { $ } from "bun";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "../src/core/config.ts";

const LABEL = "pai-editor";
const extension = join(config.repo, "editor", "vscode");
const vsix = join(extension, "pai.vsix");
const port = Number(process.env.PAI_EDITOR_PORT ?? 8788);
// The daemon's own bind address by default, so a box on the tailnet serves the editor there too.
const bind = process.env.PAI_EDITOR_BIND ?? config.host;
const daemon = config.baseUrl || `http://127.0.0.1:${config.port}`;
const auth = process.env.PAI_EDITOR_PASSWORD ? "password" : "none";

async function run(cmd: string[], cwd = config.repo) {
  const proc = Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) throw new Error(`${cmd.join(" ")} failed`);
}

async function which(binary: string) {
  return (await $`command -v ${binary}`.quiet().nothrow()).exitCode === 0;
}

/**
 * Homebrew on macOS; on Linux the standalone install under `~/.local`, so the box needs no
 * root and the binary sits next to the `pai` command.
 */
async function installCodeServer() {
  console.log("installing code-server…");
  if (process.platform === "darwin" && (await which("brew"))) await run(["brew", "install", "code-server"]);
  else
    await run([
      "sh",
      "-c",
      `curl -fsSL https://code-server.dev/install.sh | sh -s -- --method=standalone --prefix="${join(homedir(), ".local")}"`,
    ]);
  process.env.PATH = `${join(homedir(), ".local", "bin")}:${process.env.PATH ?? ""}`;
}

/** The extension reaches the daemon through settings, so a fresh editor needs no configuration. */
async function settings() {
  const path = join(homedir(), ".local", "share", "code-server", "User", "settings.json");
  await mkdir(join(path, ".."), { recursive: true });
  const current = existsSync(path) ? (JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>) : {};
  await writeFile(path, JSON.stringify({ ...current, "pai.baseUrl": daemon }, null, 2));
}

async function prepare() {
  if (!existsSync(join(extension, "node_modules"))) await run(["bun", "install"], extension);
  await run(["bun", "run", "build"], extension);
  await run(["bunx", "@vscode/vsce", "package", "--no-dependencies", "-o", "pai.vsix"], extension);
  if (!(await which("code-server"))) await installCodeServer();
  await run(["code-server", "--install-extension", vsix, "--force"]);
  await settings();
}

const serverArgs = ["--bind-addr", `${bind}:${port}`, "--auth", auth, "--disable-telemetry", config.devRoot];

async function install() {
  if (process.platform !== "linux") throw new Error("--install is for the Linux box; run `bun run editor` locally");
  await prepare();

  const unitDir = join(homedir(), ".config", "systemd", "user");
  const logs = join(config.repo, "data");
  mkdirSync(unitDir, { recursive: true });
  mkdirSync(logs, { recursive: true });
  const path = (process.env.PATH ?? "")
    .split(":")
    .filter((p) => !p.startsWith("/tmp/bun-node-"))
    .join(":");

  await Bun.write(
    join(unitDir, `${LABEL}.service`),
    `[Unit]
Description=pai browser editor (code-server)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${(await $`command -v code-server`.text()).trim()} ${serverArgs.join(" ")}
WorkingDirectory=${config.devRoot}
Restart=always
RestartSec=2
Environment=PATH=${path}
Environment=HOME=${homedir()}
${process.env.PAI_EDITOR_PASSWORD ? `Environment=PASSWORD=${process.env.PAI_EDITOR_PASSWORD}\n` : ""}StandardOutput=append:${join(logs, "editor.log")}
StandardError=append:${join(logs, "editor.log")}

[Install]
WantedBy=default.target
`,
  );
  await $`systemctl --user daemon-reload`.quiet();
  await $`systemctl --user enable --now ${LABEL}`.quiet();
  await $`loginctl enable-linger ${process.env.USER}`.nothrow().quiet();
  console.log(`editor service running on http://${bind}:${port} (logs ${join(logs, "editor.log")})`);
}

async function uninstall() {
  await $`systemctl --user disable --now ${LABEL}`.nothrow().quiet();
  rmSync(join(homedir(), ".config", "systemd", "user", `${LABEL}.service`), { force: true });
  await $`systemctl --user daemon-reload`.nothrow().quiet();
  console.log(`removed ${LABEL}`);
}

if (process.argv.includes("--uninstall")) await uninstall();
else if (process.argv.includes("--install")) await install();
else {
  await prepare();
  console.log(`\neditor     http://${bind}:${port}`);
  console.log(`daemon     ${daemon}`);
  console.log(`dashboard  ${daemon}/app\n`);
  await run(["code-server", ...serverArgs]);
}
