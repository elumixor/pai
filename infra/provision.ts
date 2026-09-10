/**
 * Creates the pai host on Hetzner Cloud from `cloud-init.yaml`.
 *
 *   HCLOUD_TOKEN=... TAILSCALE_AUTHKEY=... bun run infra/provision.ts
 *   HCLOUD_TOKEN=...                       bun run infra/provision.ts --delete
 *
 * The token is a project-scoped API token from the Hetzner console; the Tailscale key
 * should be single-use and pre-authorised, because it ends up in instance metadata.
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

const token = required("HCLOUD_TOKEN");

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

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

async function findServer() {
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

function userData(publicKey: string) {
  return readFileSync(join(import.meta.dir, "cloud-init.yaml"), "utf8")
    .replaceAll("${SSH_PUBLIC_KEY}", publicKey)
    .replaceAll("${TAILSCALE_AUTHKEY}", required("TAILSCALE_AUTHKEY"));
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
      console.log(`running at ${current.public_net.ipv4.ip}`);
      console.log("cloud-init still has a few minutes of work; then reach it as `pai` over Tailscale");
      return;
    }
    await Bun.sleep(5000);
  }
  throw new Error("server did not reach running state in five minutes");
}

async function destroy() {
  const server = await findServer();
  if (!server) {
    console.log(`no server called ${NAME}`);
    return;
  }
  await api(`/servers/${server.id}`, { method: "DELETE" });
  console.log(`deleted ${server.name} (${server.id})`);
}

await (process.argv.includes("--delete") ? destroy() : create());
