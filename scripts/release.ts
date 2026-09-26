#!/usr/bin/env bun
/**
 * `bun run release [patch|minor|major]` — the release: a clean tree, the checks, the version
 * bump as a commit and a tag, the push that makes CI build and tell the box; then it waits
 * for the box to report the new version.
 */
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
const box = remote();
if (!box || isHere(box)) process.exit(0);
const api = await boxApi(box).catch(() => undefined);
if (!api) process.exit(0);
// CI may be unable to run at all (billing, quota). The box updates itself from the tag then,
// through `pai update`; only the desktop app build is lost, which `bun run desktop:build` makes here.
let fellBack = false;
async function ciFailed(): Promise<string | undefined> {
  const run = await $`gh run list --branch ${version} --limit 1 --json databaseId,status,conclusion`.cwd(config.repo).nothrow().quiet();
  const [latest] = (JSON.parse(run.stdout.toString() || "[]") as { databaseId: number; status: string; conclusion: string }[]);
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
      if (!reason.startsWith("CI could not start")) process.exit(1);
      fellBack = true;
      await $`${process.execPath} run src/clients/cli.ts update`.cwd(config.repo).nothrow();
    }
  }
  const health = await fetch(`${api.url}/health`, { headers: { authorization: `Bearer ${api.token}` } }).then((r) => r.json() as Promise<{ version?: string }>).catch(() => undefined);
  if (health?.version === version) {
    console.log(`the box is on ${version}`);
    process.exit(0);
  }
  process.stdout.write(`\r\x1b[2Kbox still on ${health?.version ?? "?"}… (${(attempt + 1) * 15}s)`);
}
console.log("\nthe box has not picked it up in fifteen minutes; `pai update` triggers it");
process.exit(1);
