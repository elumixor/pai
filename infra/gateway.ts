#!/usr/bin/env bun
/**
 * A domain of your own in front of pai: Caddy terminates TLS on 80/443 and proxies `/editor`
 * to code-server and everything else to the daemon. Caddy needs those ports, so this is the
 * one part of pai that runs as root — hence a script you run once on the host rather than
 * something the daemon does for itself.
 *
 *   sudo PAI_DOMAIN=pai.example.com bun run infra/gateway.ts
 *
 * DNS has to point at the host first: an A record for the domain to its public address, and
 * the host firewall open on 80 and 443 (`infra/firewall.ts`).
 */
import { $ } from "bun";
import { config } from "../src/core/config.ts";

if (!config.domain) throw new Error("set PAI_DOMAIN to the domain this host answers to");
if (process.getuid?.() !== 0) throw new Error("run this with sudo: Caddy binds 80 and 443");

const caddyfile = `${config.domain} {
	handle_path /editor/* {
		reverse_proxy 127.0.0.1:${config.editor.port}
	}

	handle {
		reverse_proxy 127.0.0.1:${config.port}
	}
}
`;

if (!Bun.which("caddy")) {
  console.log("installing caddy…");
  const install =
    process.platform === "darwin"
      ? "brew install caddy"
      : "apt-get update && apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl && " +
        "curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg && " +
        "curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | tee /etc/apt/sources.list.d/caddy-stable.list && " +
        "apt-get update && apt-get install -y caddy";
  const proc = Bun.spawn(["sh", "-c", install], { stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) throw new Error("caddy install failed");
}

await Bun.write("/etc/caddy/Caddyfile", caddyfile);
await $`systemctl enable --now caddy`.nothrow();
await $`systemctl reload caddy`.nothrow();

console.log(`https://${config.domain}/         the client and the API`);
console.log(`https://${config.domain}/editor   code-server`);
console.log("\nIf the certificate does not appear, check that 80 and 443 are open and DNS points here.");
