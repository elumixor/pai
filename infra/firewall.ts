#!/usr/bin/env bun
/**
 * Opens ports on the Hetzner firewall in front of the host — the one that has no inbound
 * rules at all, which is why a public address times out. A published daemon opens 80 and
 * 443 for itself; this is for anything else, and for closing them again.
 *
 *   bun run infra/firewall.ts 80 443        # open
 *   bun run infra/firewall.ts --close       # back to nothing inbound
 */
import { config } from "../src/core/config.ts";

const token = process.env.HCLOUD_TOKEN ?? "";
if (!token) throw new Error("HCLOUD_TOKEN is not set");

const api = async (path: string, init?: RequestInit) => {
  const response = await fetch(`https://api.hetzner.cloud/v1${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<any>;
};

const ports = process.argv.slice(2).filter((argument) => /^\d+$/.test(argument));
const close = process.argv.includes("--close");
if (!close && !ports.length) throw new Error("name the ports to open, or pass --close");

const { firewalls } = await api("/firewalls");
const firewall = firewalls[0];
if (!firewall) throw new Error("this project has no firewall");

const rules = close
  ? []
  : ports.map((port) => ({
      direction: "in",
      protocol: "tcp",
      port,
      source_ips: ["0.0.0.0/0", "::/0"],
      description: `pai ${port}`,
    }));

await api(`/firewalls/${firewall.id}/actions/set_rules`, { method: "POST", body: JSON.stringify({ rules }) });
console.log(close ? `${firewall.name}: nothing inbound` : `${firewall.name}: open on ${ports.join(", ")}`);
console.log(`the host answers at ${config.domain || process.env.PAI_HOST_IP || "its public address"}`);
