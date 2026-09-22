/**
 * The box, from a laptop: where `pai ssh` and `pai claude` go. `PAI_REMOTE` names it as
 * `user@host`; without it, the Hetzner host from `PAI_HOST_IP` as the `pai` user. On the box
 * itself the same settings point at this very machine, which is how the CLI knows to run
 * things here instead.
 *
 * The box's firewall has no port 22 open; `ensureAccess` opens it for this machine's current
 * public address (and only that one) through the Hetzner API before dialling.
 */
import { mkdir } from "node:fs/promises";
import { homedir, networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { config } from "../core/config.ts";
import { allowSsh, myPublicIp } from "../domain/hetzner.ts";

export interface Remote {
  readonly user: string;
  readonly host: string;
  readonly target: string;
}

export function remote(): Remote | undefined {
  const raw = config.remote;
  if (!raw || raw === "0") return undefined;
  const [user, host] = raw.includes("@") ? (raw.split("@") as [string, string]) : ["pai", raw];
  return { user, host, target: `${user}@${host}` };
}

/** Whether the configured remote is this machine — then there is nothing to dial. */
export function isHere(r: Remote) {
  if (["localhost", "127.0.0.1"].includes(r.host)) return true;
  for (const addresses of Object.values(networkInterfaces()))
    for (const address of addresses ?? []) if (address.address === r.host) return true;
  return process.env.PAI_ON_BOX === "1";
}

/** Opens port 22 for this machine's public address; silently does nothing without a Hetzner token. */
export async function ensureAccess() {
  if (!config.hcloudToken) return { changed: false, ip: undefined };
  const ip = await myPublicIp();
  const changed = await allowSsh(ip);
  return { changed, ip };
}

/** The shell a non-interactive ssh gets has no `~/.local/bin` or bun on PATH; a login shell would. */
const PATH = `export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"`;

export function sshArgs(r: Remote, command?: string) {
  const args = ["ssh", "-t", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=30", r.target];
  if (command) args.push(`${PATH}; ${command}`);
  return args;
}

/** Runs `command` on the box with this terminal attached, or an interactive shell without one. */
export async function ssh(r: Remote, command?: string) {
  const proc = Bun.spawn(sshArgs(r, command), { stdio: ["inherit", "inherit", "inherit"] });
  return proc.exited;
}

/** A command-line argument quoted for the box's shell. */
export const quote = (arg: string) => `'${arg.replace(/'/g, `'\\''`)}'`;

/** Runs `command` on the box and returns what it printed, for output that is parsed rather than shown. */
export async function sshCapture(r: Remote, command: string) {
  const args = sshArgs(r, command).filter((a) => a !== "-t");
  const proc = Bun.spawn(args, { stdio: ["ignore", "pipe", "pipe"] });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${r.target}: ${err.trim().split("\n").pop() || `exit ${code}`}`);
  return out;
}

/** `pai <command> --json` on the box, parsed. */
export async function boxJson(r: Remote, command: string) {
  const out = await sshCapture(r, `pai ${command} --json`);
  const start = out.indexOf("{") >= 0 ? Math.min(...[out.indexOf("{"), out.indexOf("[")].filter((i) => i >= 0)) : -1;
  if (start < 0) throw new Error(`${r.target}: pai ${command} printed no JSON: ${out.trim().slice(0, 200)}`);
  return JSON.parse(out.slice(start)) as any;
}

/**
 * The box's HTTP API from a laptop: its public address and token, learned once over ssh
 * (the token is in the box's `data/config.json`) and kept in `~/.config/pai/box.json`.
 * Every command then talks https, which is fast; ssh is for shells and for relearning.
 */
export interface BoxApi {
  readonly url: string;
  readonly token: string;
}

const boxFile = join(homedir(), ".config", "pai", "box.json");

export async function boxApi(r: Remote, relearn = false): Promise<BoxApi> {
  if (!relearn) {
    const cached = await Bun.file(boxFile).json().catch(() => undefined);
    if (cached?.url && cached?.token) return cached as BoxApi;
  }
  await ensureAccess();
  const out = await sshCapture(r, `pai status --json; echo '---TOKEN---'; jq -r '.PAI_TOKEN // empty' ~/pai/data/config.json`);
  const [statusText, tokenText] = out.split("---TOKEN---");
  const start = statusText?.indexOf("{") ?? -1;
  const status = start >= 0 ? (JSON.parse(statusText!.slice(start)) as any) : {};
  const here = status.here ?? status;
  const url: string = here.public?.url ?? here.host?.baseUrl ?? "";
  const token = (tokenText ?? "").trim();
  if (!url) throw new Error(`${r.target}: the box has no public address (PAI_PUBLIC / PAI_DOMAIN)`);
  if (!token) throw new Error(`${r.target}: the box has no PAI_TOKEN, so nothing can talk to it over https`);
  await mkdir(dirname(boxFile), { recursive: true });
  await Bun.write(boxFile, JSON.stringify({ url: url.replace(/\/$/, ""), token }, null, 2));
  return { url, token };
}

/** This machine's Claude Code login, as Claude Code stores it: the keychain on macOS, a file elsewhere. */
export async function localClaudeLogin(): Promise<string | undefined> {
  if (process.platform === "darwin") {
    const proc = Bun.spawn(["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout as ReadableStream).text();
    if ((await proc.exited) === 0 && out.trim()) return out.trim();
  }
  return Bun.file(join(homedir(), ".claude", ".credentials.json")).text().catch(() => undefined);
}
