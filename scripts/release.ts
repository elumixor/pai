#!/usr/bin/env bun
/**
 * `bun run release [patch|minor|major]` — the release: a clean tree, the checks, the version
 * bump as a commit and a tag, the push that makes CI build and tell the host; then it waits for that
 * host — the box, or this machine when the daemon runs here — to report the new version.
 *
 * It reports where the release landed, or it raises a task; it never ends quietly either way, because
 * a release that silently did not land looks exactly like one that did.
 */
import { homedir } from "node:os";
import { $ } from "bun";
import { config } from "../src/core/config.ts";

const bump = process.argv[2] ?? "patch";
if (!["patch", "minor", "major"].includes(bump)) throw new Error("bun run release [patch|minor|major]");

const git = (...args: string[]) => $`git ${args}`.cwd(config.repo).quiet();
const dirty = (await git("status", "--porcelain")).stdout.toString().trim();
if (dirty) {
  console.error(`the tree is not clean — commit first:\n${dirty}`);
  process.exit(1);
}
const branch = (await git("rev-parse", "--abbrev-ref", "HEAD")).stdout.toString().trim();
if (branch !== "main") {
  console.error(`releases are cut from main, not ${branch}`);
  process.exit(1);
}

console.log("checks…");
await $`${process.execPath} run typecheck`.cwd(config.repo);
await $`${process.execPath} run test`.cwd(config.repo).quiet();

const version = (await $`npm version ${bump} -m ${"chore: v%s"}`.cwd(config.repo).quiet()).stdout.toString().trim();
await git("push", "--follow-tags");
console.log(`${version} pushed — CI builds and tells the box`);

const { remote, isHere, boxApi } = await import("../src/host/remote.ts");

/**
 * The daemon this release has to land on, and a token for it: the box over https when the remote is
 * another machine, else the daemon running here. A release cut on the box used to exit at this point
 * — every check below was skipped — which is how a release could fail to land with nothing saying so.
 * On the box the token and the address come from the daemon's own settings, the same file `boxApi`
 * reads over ssh.
 */
async function daemon(): Promise<{ url: string; token: string } | undefined> {
  const box = remote();
  if (box && !isHere(box)) return boxApi(box).catch(() => undefined);
  const settings = (await Bun.file(`${homedir()}/pai/data/config.json`).json().catch(() => undefined)) as Record<string, string> | undefined;
  const token = settings?.PAI_TOKEN ?? config.token;
  if (!token) return undefined;
  const url = settings?.PAI_PUBLIC === "1" && settings?.PAI_DOMAIN ? `https://${settings.PAI_DOMAIN}` : `http://127.0.0.1:${settings?.PAI_PORT ?? config.port}`;
  return { url, token };
}

/** Nobody is watching this terminal when it matters, so what did not land becomes a task instead. */
async function raise(api: { url: string; token: string }, title: string, nextAction: string) {
  const notes = `${version} was tagged and pushed from ${config.repo}. CI builds the daemon and calls POST /update on the host; a release that does not show up in /health within fifteen minutes either never built or never reached it.`;
  const posted = await fetch(`${api.url}/tasks`, {
    method: "POST",
    headers: { authorization: `Bearer ${api.token}`, "content-type": "application/json" },
    body: JSON.stringify({ title, status: "inbox", owner: "pai-dev", nextAction, notes }),
  })
    .then((r) => r.ok)
    .catch(() => false);
  console.error(posted ? `raised a task: ${title}` : `could not even raise a task: ${title}`);
}

const api = await daemon();
if (!api) {
  // Silence is the one outcome that is not allowed: without a daemon to ask, say so and fail.
  console.error(`${version} is pushed, but there is no daemon this release can be verified against (no PAI_TOKEN) — check it by hand`);
  process.exit(1);
}

// CI may be unable to run at all (billing, quota). The box updates itself from the tag then,
// through `pai update`; only the desktop app build is lost, which `bun run desktop:build` makes here.
let fellBack = false;
async function ciFailed(): Promise<string | undefined> {
  // `gh` is a Mac-side tool: on the box this stays quiet and the fifteen-minute timeout is what speaks.
  const run = await $`gh run list --branch ${version} --limit 1 --json databaseId,status,conclusion`.cwd(config.repo).nothrow().quiet();
  const [latest] = JSON.parse(run.stdout.toString() || "[]") as { databaseId: number; status: string; conclusion: string }[];
  if (!latest || latest.status !== "completed" || latest.conclusion === "success") return undefined;
  const jobs = await $`gh api repos/{owner}/{repo}/actions/runs/${latest.databaseId}/jobs`.cwd(config.repo).nothrow().quiet();
  const first = (JSON.parse(jobs.stdout.toString() || "{}") as { jobs?: { conclusion: string; steps: unknown[] }[] }).jobs?.[0];
  return first && first.steps.length === 0 ? "CI could not start (billing or quota) — the box is updating from the tag on its own; the desktop app needs `bun run desktop:build` here" : `CI ${latest.conclusion}`;
}

for (let attempt = 0; attempt < 60; attempt++) {
  await Bun.sleep(15_000);
  if (!fellBack && attempt >= 3) {
    const reason = await ciFailed().catch(() => undefined);
    if (reason) {
      console.log(`\n${reason}`);
      if (!reason.startsWith("CI could not start")) {
        await raise(api, `${version} did not build: ${reason}`, `Fix the CI run for ${version}, then release again or run \`pai update\` on the box`);
        process.exit(1);
      }
      fellBack = true;
      // The fallback has to prove itself too: a build that fails here is said out loud now, not
      // waited out for fifteen minutes.
      const fallback = await $`${process.execPath} run src/clients/cli.ts update`.cwd(config.repo).nothrow();
      if (fallback.exitCode !== 0) {
        await raise(api, `${version} did not reach the daemon: the fallback update failed`, `Run \`pai update\` on the box and read why it failed`);
        process.exit(1);
      }
    }
  }
  const health = await fetch(`${api.url}/health`, { headers: { authorization: `Bearer ${api.token}` } })
    .then((r) => r.json() as Promise<{ version?: string }>)
    .catch(() => undefined);
  if (health?.version === version) {
    console.log(`\n${api.url} is on ${version}${fellBack ? " (built on the host, CI could not)" : ""}`);
    process.exit(0);
  }
  process.stdout.write(`\r\x1b[2K${api.url} still on ${health?.version ?? "?"}… (${(attempt + 1) * 15}s)`);
}

console.log(`\n${version} is tagged, but ${api.url} has not reported it in fifteen minutes`);
await raise(api, `${version} was released but never reached the daemon`, `Check the CI run for ${version}, then \`pai update\` on the box`);
process.exit(1);
