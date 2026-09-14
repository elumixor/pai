import type { Subprocess } from "bun";
import { existsSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "../core/config.ts";
import { logger } from "../core/log.ts";
import { openInbound } from "./hetzner.ts";

const log = logger("publish");

/**
 * The daemon on the public internet, with nothing installed anywhere else: Caddy, run as a
 * child of the daemon, terminates TLS on 80/443 and proxies `/editor` to code-server and
 * everything else to the API. The hostname is `PAI_DOMAIN` when there is one, and otherwise
 * `<public ip>.sslip.io` — a wildcard DNS service that resolves to the address in its own
 * name, so a certificate arrives without owning a domain.
 *
 * Nothing is published without a token: the API is remote code execution, and Caddy puts it
 * one request away from anyone. Behind Caddy every request looks like it came from loopback,
 * so `auth.ts` refuses the loopback exemption to anything that carries `x-forwarded-for`.
 *
 * On Hetzner the host's firewall is opened on 80 and 443 by the daemon itself when
 * `HCLOUD_TOKEN` is set; anywhere else the two ports are yours to open.
 */

const localBin = join(homedir(), ".local", "bin");
const caddyfile = join(config.repo, "data", "Caddyfile");

let proc: Subprocess | undefined;
let stopping = false;
let url: string | undefined;
let state: "off" | "starting" | "up" | "failed" = "off";
let reason = "";

export const publicUrl = () => url;
export const publicStatus = () => ({ enabled: config.public, state, url, reason: reason || undefined });

export function startPublic() {
  if (!config.public) return () => {};
  if (!config.token) {
    log.warn("PAI_PUBLIC is set but PAI_TOKEN is empty — refusing to publish an open daemon");
    state = "failed";
    reason = "PAI_TOKEN is empty";
    return () => {};
  }
  stopping = false;
  state = "starting";
  void (async () => {
    try {
      const host = config.domain || (await sslipName());
      const bin = await binary();
      await allowLowPorts(bin);
      await writeConfig(host);
      await openFirewall();
      spawn(bin);
      url = `https://${host}`;
      state = "up";
      log.info(`${url}/ (client and API), ${url}/editor (code-server)`);
    } catch (err) {
      state = "failed";
      reason = (err as Error).message;
      log.warn(`not published: ${reason}`);
    }
  })();
  return () => {
    stopping = true;
    proc?.kill();
  };
}

/** `5.75.134.57` becomes `5-75-134-57.sslip.io`, which resolves back to the address. */
async function sslipName() {
  const ip = await publicIp();
  return `${ip.replace(/\./g, "-")}.sslip.io`;
}

async function publicIp() {
  // The host's own metadata first (Hetzner), then a public echo — either is this machine's address.
  const sources = ["http://169.254.169.254/hetzner/v1/metadata/public-ipv4", "https://api.ipify.org", "https://ifconfig.me/ip"];
  for (const source of sources) {
    try {
      const response = await fetch(source, { signal: AbortSignal.timeout(3000) });
      const text = (await response.text()).trim();
      if (response.ok && /^\d+\.\d+\.\d+\.\d+$/.test(text)) return text;
    } catch {
      /* try the next one */
    }
  }
  throw new Error("could not find this machine's public address; set PAI_DOMAIN");
}

async function binary() {
  const found = which();
  if (found) return found;
  log.info("installing caddy…");
  await mkdir(localBin, { recursive: true });
  if (process.platform === "darwin") {
    const brew = Bun.spawn(["brew", "install", "caddy"], { stdout: "ignore", stderr: "pipe" });
    if ((await brew.exited) !== 0) throw new Error(`caddy install failed: ${(await new Response(brew.stderr as ReadableStream).text()).trim().slice(-200)}`);
  } else {
    const arch = process.arch === "arm64" ? "arm64" : "amd64";
    const response = await fetch(`https://caddyserver.com/api/download?os=linux&arch=${arch}`);
    if (!response.ok) throw new Error(`caddy download failed: ${response.status}`);
    const target = join(localBin, "caddy");
    await Bun.write(target, await response.arrayBuffer());
    await chmod(target, 0o755);
  }
  const installed = which();
  if (!installed) throw new Error("caddy is still not on PATH after installing");
  return installed;
}

function which() {
  const local = join(localBin, "caddy");
  return existsSync(local) ? local : (Bun.which("caddy") ?? undefined);
}

/** 80 and 443 are privileged on Linux; the capability on the binary is the one-time sudo. */
async function allowLowPorts(bin: string) {
  if (process.platform !== "linux") return;
  const check = Bun.spawn(["getcap", bin], { stdout: "pipe", stderr: "ignore" });
  await check.exited;
  if ((await new Response(check.stdout as ReadableStream).text()).includes("cap_net_bind_service")) return;
  const setcap = Bun.spawn(["sudo", "-n", "setcap", "cap_net_bind_service=+ep", bin], { stdout: "ignore", stderr: "pipe" });
  if ((await setcap.exited) !== 0)
    throw new Error(`caddy cannot bind 80/443: run \`sudo setcap cap_net_bind_service=+ep ${bin}\` once`);
}

async function writeConfig(host: string) {
  const api = `${config.host}:${config.port}`;
  const editor = `${config.editor.host}:${config.editor.port}`;
  const editorBlock = config.editor.enabled
    ? `
	redir /editor /editor/ 301
	handle_path /editor/* {
		reverse_proxy ${editor}
	}
`
    : "";
  await mkdir(join(caddyfile, ".."), { recursive: true });
  await Bun.write(
    caddyfile,
    `{
	admin off
}

${host} {${editorBlock}
	handle {
		reverse_proxy ${api}
	}
}
`,
  );
}

async function openFirewall() {
  if (!config.hcloudToken) return;
  try {
    const opened = await openInbound([80, 443]);
    if (opened) log.info("hetzner firewall: 80 and 443 open");
  } catch (err) {
    log.warn(`hetzner firewall: ${(err as Error).message}`);
  }
}

function spawn(bin: string) {
  proc = Bun.spawn([bin, "run", "--config", caddyfile, "--adapter", "caddyfile"], {
    cwd: config.repo,
    stdout: "ignore",
    stderr: "pipe",
    env: { ...process.env, PATH: `${localBin}:${process.env.PATH}` },
  });
  log.info(`caddy (pid ${proc.pid})`);
  void (async () => {
    const err = await new Response(proc!.stderr as ReadableStream).text();
    const code = await proc!.exited;
    if (stopping) return;
    state = "failed";
    reason = err.trim().slice(-300);
    log.warn(`caddy exited (code ${code}) ${reason} — restarting in 5s`);
    setTimeout(() => spawn(bin), 5000);
  })();
}
