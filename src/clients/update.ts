/**
 * `pai update` (and `pai dev update`): the daemon pulls what its channel says is new and restarts — core's own
 * `POST /update`, so it works whatever modules failed to load — and this checkout, when it is a laptop's, is
 * pulled too, with its module clones.
 */
import { $ } from "bun";
import { config } from "../core/config.ts";
import { isHere, remote } from "../host/remote.ts";

/** How the command line talks to the daemon and prints. */
export interface UpdateCli {
  api(path: string): Promise<any>;
  post(path: string, data: unknown): Promise<any>;
  out(data: unknown, pretty: () => string): void;
}

const UNREACHABLE = "Unable to connect";

interface Status {
  readonly head: string;
  readonly branch: string;
  readonly behind: number;
  readonly dirty: boolean;
  readonly updated?: boolean;
  readonly restarting?: boolean;
  readonly reason?: string;
  readonly error?: string;
}

const line = (data: Status) =>
  data.error
    ? data.error
    : data.updated
      ? `updated to ${data.head}${data.restarting ? " — restarting" : ""}`
      : `${data.head} on ${data.branch} · ${data.behind} behind${data.dirty ? " · dirty" : ""}${data.reason ? ` · ${data.reason}` : ""}`;

const git = (...args: string[]) => $`git ${args}`.cwd(config.repo).nothrow().quiet();

/** A laptop's checkout: a pull and a rebuild of what is installed here; the daemon is the box's and updates itself. */
async function updateClient() {
  const before = (await git("rev-parse", "--short", "HEAD")).stdout.toString().trim();
  const dirty = (await git("status", "--porcelain")).stdout.toString().trim().length > 0;
  if (!dirty) await git("pull", "--ff-only", "--quiet");
  const head = (await git("rev-parse", "--short", "HEAD")).stdout.toString().trim();
  const external = await import("../modules/external.ts");
  const modules: Record<string, string> = {};
  for (const name of Object.keys((await external.readConfig()).modules).filter(external.isInstalled)) {
    const r = await external.update(name);
    modules[name] = r.updated ? `${r.from} → ${r.to}` : (r.reason ?? "up to date");
  }
  const updated = head !== before;
  if (updated) await $`${process.execPath} install`.cwd(config.repo).quiet();
  return { head, updated, dirty, modules };
}

/** The daemon's own update, through its API; with the daemon down on this machine, core's update runs right here. */
async function updateDaemon(cli: UpdateCli, check: boolean, force: boolean, local: boolean): Promise<Status> {
  const asked = check ? cli.api("/update") : cli.post("/update", { force });
  return (asked as Promise<Status>).catch(async (err: Error) => {
    if (!local || !err.message.includes(UNREACHABLE)) throw err;
    const core = await import("../domain/update.ts");
    return check ? core.status() : core.update(force);
  });
}

export async function updateCommand(cli: UpdateCli, rest: readonly string[]): Promise<number> {
  const box = remote();
  const laptop = Boolean(box && !isHere(box));
  const check = rest.includes("--check");
  const daemon = await updateDaemon(cli, check, rest.includes("--force"), !laptop);
  const client = laptop && !check ? await updateClient() : undefined;
  cli.out({ box: daemon, client }, () =>
    [
      `${laptop ? "box   " : "here  "}${line(daemon)}`,
      ...(client ? [`client ${client.head}${client.updated ? " — updated" : " — up to date"}`, ...Object.entries(client.modules).map(([name, r]) => `  ${name.padEnd(10)} ${r}`)] : []),
    ].join("\n"),
  );
  return daemon.error ? 1 : 0;
}
