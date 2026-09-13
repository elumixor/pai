import { $ } from "bun";
import { config } from "../core/config.ts";
import { logger } from "../core/log.ts";

const log = logger("publish");

let url: string | undefined;

export const publicUrl = () => url;

/**
 * Tailscale Funnel puts the daemon on the public internet: a real hostname, a real
 * certificate, no firewall rule and no port forwarding. It is only ever switched on together
 * with a token — the API is remote code execution, and an open one would be handing it away.
 */
export function startPublic() {
  if (!config.public) return () => {};
  if (!config.token) {
    log.warn("PAI_PUBLIC is set but PAI_TOKEN is empty — refusing to publish an open daemon");
    return () => {};
  }

  void (async () => {
    const name = await hostname();
    if (!name) return log.warn("tailscale is not up; nothing published");
    const started = await $`tailscale funnel --bg ${config.port}`.nothrow().quiet();
    if (started.exitCode !== 0)
      return log.warn(`funnel failed: ${started.stderr.toString().trim().slice(-300) || "is Funnel enabled for this tailnet?"}`);
    url = `https://${name}`;
    log.info(`${url}/ui/ (token required)`);
  })();

  return () => {
    void $`tailscale funnel --https=443 off`.nothrow().quiet();
  };
}

/** The machine's Funnel hostname, e.g. `pai.tail1234.ts.net`. */
async function hostname() {
  const status = await $`tailscale status --json`.nothrow().quiet();
  if (status.exitCode !== 0) return undefined;
  const parsed = JSON.parse(status.stdout.toString()) as { Self?: { DNSName?: string } };
  return parsed.Self?.DNSName?.replace(/\.$/, "");
}
