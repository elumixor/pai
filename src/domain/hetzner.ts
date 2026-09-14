/** Actual Hetzner Cloud hosting spend, priced from the account's own /pricing table — not an estimate. */
import { config } from "../core/config.ts";

const API = "https://api.hetzner.cloud/v1";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${config.hcloudToken}`, "content-type": "application/json" },
  });
  if (!res.ok) throw new Error(`hetzner api ${res.status}: ${(await res.text()).slice(0, 400)}`);
  return (await res.json()) as T;
}

interface Money {
  readonly net: string;
  readonly gross: string;
}
interface LocationPrice {
  readonly location: string;
  readonly price_hourly: Money;
  readonly price_monthly: Money;
}
interface Pricing {
  readonly currency: string;
  readonly server_backup: { readonly percentage: string };
  readonly server_types: readonly { readonly name: string; readonly prices: readonly LocationPrice[] }[];
  readonly load_balancer_types: readonly { readonly name: string; readonly prices: readonly LocationPrice[] }[];
  readonly volume: { readonly price_per_gb_month: Money };
  readonly floating_ip: { readonly price_monthly: Money };
  readonly primary_ips: readonly { readonly type: string; readonly prices: readonly LocationPrice[] }[];
}

interface Server {
  readonly id: number;
  readonly name: string;
  readonly server_type: { readonly name: string };
  // Newer accounts get `location` and a null `datacenter`; older responses carry the location
  // inside the datacenter. Both shapes are live.
  readonly location?: { readonly name: string };
  readonly datacenter?: { readonly location: { readonly name: string } } | null;
  readonly backup_window: string | null;
}
interface Volume {
  readonly id: number;
  readonly name: string;
  readonly size: number;
}
interface PrimaryIp {
  readonly id: number;
  readonly name: string;
  readonly type: string;
  readonly location: { readonly name: string };
}
interface FloatingIp {
  readonly id: number;
  readonly description: string | null;
}
interface LoadBalancer {
  readonly id: number;
  readonly name: string;
  readonly load_balancer_type: { readonly name: string };
  readonly location: { readonly name: string };
}

export interface CostLine {
  readonly name: string;
  readonly kind: "server" | "server-backup" | "volume" | "primary-ip" | "floating-ip" | "load-balancer";
  readonly monthly: number;
}
export interface Cost {
  readonly currency: string;
  readonly monthlyTotal: number;
  readonly lines: readonly CostLine[];
}

const gross = (m: Money) => Number(m.gross);

/** No token, no query — this is a read against the live account, so it fails loudly rather than guessing. */
function requireToken() {
  if (!config.hcloudToken) throw new Error("HCLOUD_TOKEN is not set");
  return config.hcloudToken;
}

export async function cost(): Promise<Cost> {
  requireToken();
  const [{ pricing }, { servers }, { volumes }, { primary_ips }, { floating_ips }, { load_balancers }] = await Promise.all([
    api<{ pricing: Pricing }>("/pricing"),
    api<{ servers: Server[] }>("/servers"),
    api<{ volumes: Volume[] }>("/volumes"),
    api<{ primary_ips: PrimaryIp[] }>("/primary_ips"),
    api<{ floating_ips: FloatingIp[] }>("/floating_ips"),
    api<{ load_balancers: LoadBalancer[] }>("/load_balancers"),
  ]);

  const lines: CostLine[] = [];

  for (const server of servers) {
    const type = pricing.server_types.find((t) => t.name === server.server_type.name);
    const where = server.location?.name ?? server.datacenter?.location.name;
    const price = type?.prices.find((p) => p.location === where);
    if (!price) continue;
    const monthly = gross(price.price_monthly);
    lines.push({ name: server.name, kind: "server", monthly });
    if (server.backup_window) {
      const pct = Number(pricing.server_backup.percentage) / 100;
      lines.push({ name: `${server.name} backups`, kind: "server-backup", monthly: monthly * pct });
    }
  }

  for (const volume of volumes) {
    lines.push({ name: volume.name, kind: "volume", monthly: volume.size * gross(pricing.volume.price_per_gb_month) });
  }

  // A server's price no longer includes its IPv4; the address is billed on its own.
  for (const ip of primary_ips) {
    const price = pricing.primary_ips.find((t) => t.type === ip.type)?.prices.find((p) => p.location === ip.location.name);
    const monthly = price ? gross(price.price_monthly) : 0;
    if (monthly > 0) lines.push({ name: `${ip.name} (${ip.type})`, kind: "primary-ip", monthly });
  }

  for (const ip of floating_ips) {
    lines.push({ name: ip.description ?? `floating ip ${ip.id}`, kind: "floating-ip", monthly: gross(pricing.floating_ip.price_monthly) });
  }

  for (const lb of load_balancers) {
    const type = pricing.load_balancer_types.find((t) => t.name === lb.load_balancer_type.name);
    const price = type?.prices.find((p) => p.location === lb.location.name);
    if (price) lines.push({ name: lb.name, kind: "load-balancer", monthly: gross(price.price_monthly) });
  }

  return { currency: pricing.currency, monthlyTotal: lines.reduce((sum, l) => sum + l.monthly, 0), lines };
}

interface Rule {
  readonly direction: "in" | "out";
  readonly protocol: string;
  readonly port?: string;
  readonly source_ips?: readonly string[];
  readonly destination_ips?: readonly string[];
  readonly description?: string | null;
}

/**
 * Opens TCP ports to the world on the project's firewall, keeping every rule already there.
 * Returns whether anything changed. The daemon uses it to publish itself on 80 and 443.
 */
export async function openInbound(ports: readonly number[]) {
  requireToken();
  const { firewalls } = await api<{ firewalls: { id: number; rules: Rule[] }[] }>("/firewalls");
  const firewall = firewalls[0];
  if (!firewall) throw new Error("this project has no firewall");
  const open = (port: number) =>
    firewall.rules.some(
      (rule) => rule.direction === "in" && rule.protocol === "tcp" && rule.port === String(port) && rule.source_ips?.includes("0.0.0.0/0"),
    );
  const missing = ports.filter((port) => !open(port));
  if (!missing.length) return false;
  const rules: Rule[] = [
    ...firewall.rules.map(({ direction, protocol, port, source_ips, destination_ips, description }) => ({
      direction,
      protocol,
      port,
      source_ips,
      destination_ips,
      description,
    })),
    ...missing.map((port) => ({
      direction: "in" as const,
      protocol: "tcp",
      port: String(port),
      source_ips: ["0.0.0.0/0", "::/0"],
      description: `pai ${port}`,
    })),
  ];
  await api(`/firewalls/${firewall.id}/actions/set_rules`, { method: "POST", body: JSON.stringify({ rules }) });
  return true;
}
