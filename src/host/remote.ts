/**
 * The box, from a laptop: where `pai ssh` and `pai claude` go. `PAI_REMOTE` names it as
 * `user@host`; without it, the Hetzner host from `PAI_HOST_IP` as the `pai` user. On the box
 * itself the same settings point at this very machine, which is how the CLI knows to run
 * things here instead.
 *
 * The box's firewall has no port 22 open; `ensureAccess` opens it for this machine's current
 * public address (and only that one) through the Hetzner API before dialling.
 */
import { networkInterfaces } from "node:os";
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
