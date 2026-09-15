/**
 * Turns a freshly provisioned host into a running pai: a read-only deploy key, the
 * checkout, dependencies, secrets and state carried over, then the service.
 *
 *   bun run infra/bootstrap.ts [--host pai] [--env <file>] [--state <dir>]
 *
 * `--state` is a directory holding the previous host's `data/pai.db` and
 * `workspace/memory`; how it got there is the old host's business (scp, gcloud, a backup).
 *
 * Everything runs over SSH, so the host has to be on the tailnet already. Secrets travel
 * over that connection and never through git.
 */
import { $ } from "bun";
import { join } from "node:path";
import { config } from "../src/core/config.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const host = flag("host") ?? "pai";
const state = flag("state") ?? config.repo;
const envFile = flag("env") ?? join(config.repo, ".env");
const REPO = "elumixor/pai";
// node-gyp (node-pty's install script) re-invokes bun by name, so the remote shell needs
// bun on PATH rather than an absolute path at the call site.
const remote = (command: string) => $`ssh ${host} ${`export PATH="$HOME/.bun/bin:$PATH"; ${command}`}`;

async function ensureDeployKey() {
  const existing = await $`ssh ${host} 'cat ~/.ssh/id_ed25519_pai.pub 2>/dev/null'`.nothrow().quiet();
  const publicKey = existing.exitCode === 0 ? existing.stdout.toString().trim() : await createKey();
  const keys = await $`gh api repos/${REPO}/keys --jq '.[].key'`.quiet();
  if (keys.stdout.toString().includes(publicKey.split(" ")[1] ?? "")) return;
  await $`gh api repos/${REPO}/keys -f title=${`${host} (read-only)`} -f key=${publicKey} -F read_only=true`.quiet();
  console.log("added a read-only deploy key");
}

async function createKey() {
  await remote(`ssh-keygen -t ed25519 -N '' -f ~/.ssh/id_ed25519_pai -C pai-${host}`);
  await remote("ssh-keyscan -H github.com >> ~/.ssh/known_hosts 2>/dev/null");
  await remote(
    "printf 'Host github.com\\n  IdentityFile ~/.ssh/id_ed25519_pai\\n  IdentitiesOnly yes\\n' >> ~/.ssh/config",
  );
  return (await $`ssh ${host} 'cat ~/.ssh/id_ed25519_pai.pub'`.text()).trim();
}

async function clone() {
  const present = await $`ssh ${host} 'test -d ~/pai/.git'`.nothrow().quiet();
  if (present.exitCode === 0) {
    await remote("cd ~/pai && git fetch --tags --force && git pull --ff-only");
    return;
  }
  await remote(`git clone git@github.com:${REPO}.git ~/pai`);
}

async function carryState() {
  await $`scp ${envFile} ${host}:~/pai/.env`;
  await remote("chmod 600 ~/pai/.env");
  await $`tar czf - -C ${state} data/pai.db workspace/memory | ssh ${host} 'tar xzf - -C ~/pai'`;
  console.log(`carried over ${envFile}, the database and long-term memory from ${state}`);
}

async function install() {
  await remote("cd ~/pai && bun install");
  await remote("cd ~/pai && bun run build:ui");
  await remote("cd ~/pai && bun run src/clients/cli.ts install");
  await remote("systemctl --user is-active pai");
}

await ensureDeployKey();
await clone();
await carryState();
await install();
console.log(`\n${host} is running pai; check with: ssh ${host} '~/.local/bin/pai tasks'`);
