import { $ } from "bun";
import { config } from "../core/config.ts";
import { logger } from "../core/log.ts";

const log = logger("publish");

let url: string | undefined;

export const publicUrl = () => url;

/**
 * Tailscale Funnel puts the daemon on the public internet: a real hostname, a real
 * certificate, no firewall rule and no port forwarding. `/` is the client and the API,
 * `/editor` is code-server, so one address is the whole system from any device.
 *
 * It is only ever switched on together with a token — the API is remote code execution, and
 * an open one would be handing it away. A domain of your own is `infra/gateway.ts` instead.
 */
export function startPublic() {
  if (!config.public) return () => {};
  if (!config.token) {
    log.warn("PAI_PUBLIC is set but PAI_TOKEN is empty — refusing to publish an open daemon");
    return () => {};
  }
  if (config.domain) {
    log.info(`PAI_DOMAIN is set; serve ${config.domain} with infra/gateway.ts rather than Funnel`);
    url = `https://${config.domain}`;
    return () => {};
  }

  void (async () => {
    const name = await hostname();
    if (!name) return log.warn("tailscale is not up; nothing published");
    if (!(await mount("/", config.port))) return;
    // The editor is a second mount on the same hostname, so one URL carries both.
    if (config.editor.enabled) await mount("/editor", config.editor.port);
    url = `https://${name}`;
    log.info(`${url}/ (client) and ${url}/editor (code-server)`);
  })();

  return () => {
    void $`tailscale funnel --https=443 off`.nothrow().quiet();
  };
}

async function mount(path: string, port: number) {
  const args = path === "/" ? ["funnel", "--bg", String(port)] : ["funnel", "--bg", "--set-path", path, String(port)];
  const result = await $`tailscale ${args}`.nothrow().quiet();
  if (result.exitCode === 0) return true;
  log.warn(`funnel ${path} failed: ${result.stderr.toString().trim().slice(-300) || "is Funnel enabled for this tailnet?"}`);
  return false;
}

/** The machine's Funnel hostname, e.g. `pai.tail1234.ts.net`. */
async function hostname() {
  const status = await $`tailscale status --json`.nothrow().quiet();
  if (status.exitCode !== 0) return undefined;
  const parsed = JSON.parse(status.stdout.toString()) as { Self?: { DNSName?: string } };
  return parsed.Self?.DNSName?.replace(/\.$/, "");
}
