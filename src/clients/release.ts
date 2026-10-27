/**
 * `pai dev release [patch|minor|major]` (`bun run release`): a clean tree, the checks, the version bump as a
 * commit and a tag, the push that makes CI build and tell the host; then it waits for that host — the box, or this
 * machine when the daemon runs here — to report the new version.
 *
 * It reports where the release landed, or it raises a task; it never ends quietly either way, because a release
 * that silently did not land looks exactly like one that did.
 */
import { homedir } from "node:os";
import { $ } from "bun";
import { config } from "../core/config.ts";
import { boxApi, isHere, remote } from "../host/remote.ts";

const BUMPS = ["patch", "minor", "major"] as const;
const POLL_MS = 15_000;
const POLLS = 60;
/** Polls before CI's own verdict is asked for: a run needs a minute to exist. */
const CI_GRACE_POLLS = 3;

interface Api {
  readonly url: string;
  readonly token: string;
}

export class ReleaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseError";
  }
}

const git = (...args: string[]) => $`git ${args}`.cwd(config.repo).quiet();

/**
 * The daemon this release has to land on, and a token for it: the box over https when the remote is another
 * machine, else the daemon running here, from its own settings — the same file `boxApi` reads over ssh.
 */
async function daemon(): Promise<Api | undefined> {
  const box = remote();
  if (box && !isHere(box)) return boxApi(box).catch(() => undefined);
  const settings = (await Bun.file(`${homedir()}/pai/data/config.json`)
    .json()
    .catch(() => undefined)) as Record<string, string> | undefined;
  const token = settings?.PAI_TOKEN ?? config.token;
  if (!token) return undefined;
  const url = settings?.PAI_PUBLIC === "1" && settings?.PAI_DOMAIN ? `https://${settings.PAI_DOMAIN}` : `http://127.0.0.1:${settings?.PAI_PORT ?? config.port}`;
  return { url, token };
}

/** Nobody is watching this terminal when it matters, so what did not land becomes a task instead. */
async function raise(api: Api, version: string, title: string, nextAction: string) {
  const notes = `${version} was tagged and pushed from ${config.repo}. CI builds the daemon and calls POST /update on the host; a release that does not show up in /health within fifteen minutes either never built or never reached it.`;
  const posted = await fetch(`${api.url}/tasks`, {
    method: "POST",
    headers: { authorization: `Bearer ${api.token}`, "content-type": "application/json" },
    body: JSON.stringify({ title, status: "inbox", owner: "pai", nextAction, notes }),
  })
    .then((r) => r.ok)
    .catch(() => false);
  console.error(posted ? `raised a task: ${title}` : `could not even raise a task: ${title}`);
}

/** CI may be unable to run at all (billing, quota); `gh` is a Mac-side tool, so on the box this stays quiet. */
async function ciFailed(version: string): Promise<string | undefined> {
  const run = await $`gh run list --branch ${version} --limit 1 --json databaseId,status,conclusion`.cwd(config.repo).nothrow().quiet();
  const [latest] = JSON.parse(run.stdout.toString() || "[]") as { databaseId: number; status: string; conclusion: string }[];
  if (!latest || latest.status !== "completed" || latest.conclusion === "success") return undefined;
  const jobs = await $`gh api repos/{owner}/{repo}/actions/runs/${latest.databaseId}/jobs`.cwd(config.repo).nothrow().quiet();
  const first = (JSON.parse(jobs.stdout.toString() || "{}") as { jobs?: { conclusion: string; steps: unknown[] }[] }).jobs?.[0];
  return first && first.steps.length === 0 ? "CI could not start (billing or quota) — the box is updating from the tag on its own" : `CI ${latest.conclusion}`;
}

async function cut(bump: string) {
  const dirty = (await git("status", "--porcelain")).stdout.toString().trim();
  if (dirty) throw new ReleaseError(`the tree is not clean — commit first:\n${dirty}`);
  const branch = (await git("rev-parse", "--abbrev-ref", "HEAD")).stdout.toString().trim();
  if (branch !== "main") throw new ReleaseError(`releases are cut from main, not ${branch}`);
  console.log("checks…");
  await $`${process.execPath} run typecheck`.cwd(config.repo);
  await $`${process.execPath} run test`.cwd(config.repo).quiet();
  const version = (await $`npm version ${bump} -m ${"chore: v%s"}`.cwd(config.repo).quiet()).stdout.toString().trim();
  await git("push", "--follow-tags");
  console.log(`${version} pushed — CI builds and tells the box`);
  return version;
}

export async function releaseCommand(rest: readonly string[]): Promise<number> {
  const bump = rest.find((a) => !a.startsWith("--")) ?? "patch";
  if (!(BUMPS as readonly string[]).includes(bump)) throw new ReleaseError("pai dev release [patch|minor|major]");
  const version = await cut(bump);
  const api = await daemon();
  // Silence is the one outcome that is not allowed: without a daemon to ask, say so and fail.
  if (!api) throw new ReleaseError(`${version} is pushed, but there is no daemon this release can be verified against (no PAI_TOKEN) — check it by hand`);

  let fellBack = false;
  for (let attempt = 0; attempt < POLLS; attempt++) {
    await Bun.sleep(POLL_MS);
    if (!fellBack && attempt >= CI_GRACE_POLLS) {
      const reason = await ciFailed(version).catch(() => undefined);
      if (reason && !reason.startsWith("CI could not start")) {
        console.log(`\n${reason}`);
        await raise(api, version, `${version} did not build: ${reason}`, `Fix the CI run for ${version}, then release again or run \`pai update\``);
        return 1;
      }
      if (reason) {
        console.log(`\n${reason}`);
        fellBack = true;
        // The fallback has to prove itself too: a build that fails here is said out loud now, not waited out.
        const fallback = await $`${process.execPath} run src/clients/cli.ts update`.cwd(config.repo).nothrow();
        if (fallback.exitCode !== 0) {
          await raise(api, version, `${version} did not reach the daemon: the fallback update failed`, "Run `pai update` and read why it failed");
          return 1;
        }
      }
    }
    const health = await fetch(`${api.url}/health`, { headers: { authorization: `Bearer ${api.token}` } })
      .then((r) => r.json() as Promise<{ version?: string }>)
      .catch(() => undefined);
    if (health?.version === version) {
      console.log(`\n${api.url} is on ${version}${fellBack ? " (built on the host, CI could not)" : ""}`);
      return 0;
    }
    process.stdout.write(`\r\x1b[2K${api.url} still on ${health?.version ?? "?"}… (${((attempt + 1) * POLL_MS) / 1000}s)`);
  }
  console.log(`\n${version} is tagged, but ${api.url} has not reported it in fifteen minutes`);
  await raise(api, version, `${version} was released but never reached the daemon`, `Check the CI run for ${version}, then \`pai update\``);
  return 1;
}
