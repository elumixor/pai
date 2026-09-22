/**
 * Creates the pai host on Hetzner Cloud from `cloud-init.yaml`. `bun run infra` is the whole
 * thing — this, then `bootstrap.ts`; on its own:
 *
 *   HCLOUD_TOKEN=... bun run infra/provision.ts
 *   HCLOUD_TOKEN=... bun run infra/provision.ts --delete
 *
 * The token is a project-scoped API token from the Hetzner console. `TAILSCALE_AUTHKEY`,
 * if set, joins the host to a tailnet as well — single-use and pre-authorised, because it
 * ends up in instance metadata; without it the host is reached with `pai ssh`.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const API = "https://api.hetzner.cloud/v1";

/** CX43: 8 vCPU, 16 GB, 160 GB, ~€16/mo in Nuremberg — the closest region to Prague. */
const SERVER_TYPE = "cx43";
const IMAGE = "ubuntu-24.04";
const LOCATION = "nbg1";
const NAME = "pai";
const FIREWALL_NAME = "pai-no-inbound";

class HetznerError extends Error {
  constructor(readonly status: number, readonly detail: string) {
    super(`hetzner api ${status}: ${detail}`);
    this.name = "HetznerError";
  }
}

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const token = required("HCLOUD_TOKEN");

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init?.headers },
  });
  const text = await res.text();
  if (!res.ok) throw new HetznerError(res.status, text.slice(0, 400));
  return (text ? JSON.parse(text) : {}) as T;
}

interface Server {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly public_net: { readonly ipv4: { readonly ip: string } | null };
}

export async function findServer() {
  const { servers } = await api<{ servers: Server[] }>(`/servers?name=${NAME}`);
  return servers[0];
}

async function ensureFirewall() {
  const { firewalls } = await api<{ firewalls: { id: number; name: string }[] }>(`/firewalls?name=${FIREWALL_NAME}`);
  if (firewalls[0]) return firewalls[0].id;
  // No inbound rules at all: the host is reachable over Tailscale, which dials out.
  const created = await api<{ firewall: { id: number } }>("/firewalls", {
    method: "POST",
    body: JSON.stringify({ name: FIREWALL_NAME, rules: [] }),
  });
  return created.firewall.id;
}

async function ensureSshKey() {
  const publicKey = readFileSync(join(homedir(), ".ssh", "id_ed25519.pub"), "utf8").trim();
  const { ssh_keys } = await api<{ ssh_keys: { id: number; public_key: string }[] }>("/ssh_keys");
  const existing = ssh_keys.find((key) => key.public_key.split(" ")[1] === publicKey.split(" ")[1]);
  if (existing) return { id: existing.id, publicKey };
  const created = await api<{ ssh_key: { id: number } }>("/ssh_keys", {
    method: "POST",
    body: JSON.stringify({ name: `${NAME}-${Date.now()}`, public_key: publicKey }),
  });
  return { id: created.ssh_key.id, publicKey };
}

/** `tskey-auth-<id>-<secret>`. A key pasted with its prefix twice fails silently inside cloud-init. */
const AUTHKEY = /^tskey-auth-[A-Za-z0-9]+-[A-Za-z0-9]+$/;

function userData(publicKey: string) {
  const authkey = process.env.TAILSCALE_AUTHKEY ?? "";
  if (authkey && !AUTHKEY.test(authkey)) throw new Error(`TAILSCALE_AUTHKEY is not shaped like tskey-auth-<id>-<secret>: ${authkey}`);
  const yaml = readFileSync(join(import.meta.dir, "cloud-init.yaml"), "utf8").replaceAll("${SSH_PUBLIC_KEY}", publicKey);
  return authkey
    ? yaml.replaceAll("${TAILSCALE_AUTHKEY}", authkey)
    : yaml.replace(/^.*tailscale.*\n/gm, "");
}

/** The host, created if there is none; its public address either way. */
export async function ensureServer() {
  const existing = await findServer();
  if (existing?.public_net.ipv4) {
    console.log(`${existing.name} exists at ${existing.public_net.ipv4.ip}`);
    return existing.public_net.ipv4.ip;
  }
  return create();
}

async function create() {
  if (await findServer()) throw new Error(`a server called ${NAME} already exists`);
  const [firewall, sshKey] = await Promise.all([ensureFirewall(), ensureSshKey()]);
  const { server } = await api<{ server: Server }>("/servers", {
    method: "POST",
    body: JSON.stringify({
      name: NAME,
      server_type: SERVER_TYPE,
      image: IMAGE,
      location: LOCATION,
      ssh_keys: [sshKey.id],
      firewalls: [{ firewall: firewall }],
      user_data: userData(sshKey.publicKey),
      labels: { app: "pai" },
    }),
  });
  console.log(`created ${server.name} (${server.id})`);

  for (let attempt = 0; attempt < 60; attempt++) {
    const current = await findServer();
    if (current?.status === "running" && current.public_net.ipv4) {
      console.log(`running at ${current.public_net.ipv4.ip}; cloud-init has a few minutes of work left`);
      return current.public_net.ipv4.ip;
    }
    await Bun.sleep(5000);
  }
  throw new Error("server did not reach running state in five minutes");
}

export async function destroy() {
  const server = await findServer();
  if (!server) {
    console.log(`no server called ${NAME}`);
    return;
  }
  await api(`/servers/${server.id}`, { method: "DELETE" });
  console.log(`deleted ${server.name} (${server.id})`);
}

if (import.meta.main) await (process.argv.includes("--delete") ? destroy() : create());
