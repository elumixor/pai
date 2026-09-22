#!/usr/bin/env bun
/**
 * `bun run infra` — the whole host from nothing, or brought up to date: the Hetzner server
 * from `cloud-init.yaml` (kept if it exists), its firewall opened for this machine, then
 * `bootstrap.ts` over ssh (deploy key, checkout, `.env`, state, the service). Idempotent.
 *
 *   bun run infra              # create or update
 *   bun run infra --destroy    # delete the server
 */
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../src/core/config.ts";
import { allowSsh, myPublicIp } from "../src/domain/hetzner.ts";
import { bootstrap } from "./bootstrap.ts";
import { destroy, ensureServer } from "./provision.ts";

if (process.argv.includes("--destroy")) {
  await destroy();
  process.exit(0);
}

const ip = await ensureServer();

// The address is what `pai ssh` and `pai claude` dial; a fresh host is written into .env.
const envFile = join(config.repo, ".env");
const env = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
if (!/^PAI_HOST_IP=/m.test(env)) appendFileSync(envFile, `${env.endsWith("\n") || !env ? "" : "\n"}PAI_HOST_IP=${ip}\n`);
else if (!env.includes(`PAI_HOST_IP=${ip}`)) console.log(`note: .env has another PAI_HOST_IP; the host is at ${ip}`);

await allowSsh(await myPublicIp());
const target = `pai@${ip}`;

// cloud-init is still installing on a new host; ssh answers once the user exists.
for (let attempt = 0; ; attempt++) {
  const probe = Bun.spawn(["ssh", "-o", "ConnectTimeout=5", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", target, "test -x ~/.bun/bin/bun"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  if ((await probe.exited) === 0) break;
  if (attempt >= 120) throw new Error(`${target} did not come up in ten minutes`);
  if (attempt === 0) console.log(`waiting for ${target}…`);
  await Bun.sleep(5000);
}

await bootstrap(target);
