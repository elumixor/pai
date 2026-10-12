#!/usr/bin/env bun
export {}; // dynamic imports only, but top-level await needs this file to be a module
const argv = process.argv.slice(2);
// `pai dev <command>` are the daemon's own controls; everything else is what a person uses.
const dev = argv[0] === "dev";
const [cmd, ...args] = dev ? argv.slice(1) : argv;

// The foreground daemon is the dev loop: verbose, and no bot fighting the installed one for the token.
// These have to be set before config.ts is evaluated, so config is imported after.
const foreground = args.includes("--foreground") || args.includes("-f");
if (dev && cmd === "daemon" && foreground) process.env.PAI_VERBOSE ??= "1";
const { config } = await import("../core/config.ts");
const jsonOut = args.includes("--json");
/** Flags that take a value: the word after one is its value, not a positional argument. */
const VALUED = new Set(["--id", "--project", "--limit", "--owner", "--due"]);
const positional = args.filter((a, i) => !a.startsWith("--") && !VALUED.has(args[i - 1] ?? ""));
const r = await import("../host/remote.ts");
const box = r.remote();
const remoteBox = box && !r.isHere(box) ? box : undefined;

// On the box the API is the daemon next door; from a laptop it is the box's https address,
// and there is no daemon here to talk to.
let base = `http://${config.host}:${config.port}`;
let auth: Record<string, string> = config.token ? { authorization: `Bearer ${config.token}` } : {};
async function aim(relearn = false) {
  if (!remoteBox) return;
  const api = await r.boxApi(remoteBox, relearn);
  base = api.url;
  auth = { authorization: `Bearer ${api.token}` };
}
await aim();

function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function api(path: string, init?: RequestInit, retried = false): Promise<any> {
  const res = await fetch(base + path, { ...init, headers: { ...auth, ...(init?.headers as Record<string, string>) } });
  // A stale token or address for the box: learn them again over ssh, once.
  if (res.status === 401 && remoteBox && !retried) {
    await aim(true);
    return api(path, init, true);
  }
  const text = await res.text();
  try {
    return JSON.parse(text) as any;
  } catch {
    throw new Error(`${res.status} ${text.slice(0, 200)}`);
  }
}

const post = (path: string, data: unknown) =>
  api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
const patch = (path: string, data: unknown) =>
  api(path, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });

function out(data: unknown, pretty?: () => string) {
  if (jsonOut || !pretty) console.log(JSON.stringify(data, null, 2));
  else console.log(pretty());
}

const clock = (ts: number) => new Date(ts).toISOString().slice(11, 19);

async function follow(sessionId?: string, raw = false) {
  const url = `${base}/events?follow=1${sessionId ? `&session=${sessionId}` : ""}`;
  const res = await fetch(url);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value);
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      const e = JSON.parse(line.slice(6));
      if (raw) console.log(JSON.stringify(e));
      else console.log(`${clock(e.ts)} ${(e.sessionId ?? "").slice(0, 6).padEnd(6)} ${e.kind.padEnd(18)} ${summarize(e)}`);
    }
  }
}

function summarize(e: any): string {
  const p = e.payload ?? {};
  if (e.kind === "session.tool") return `${p.name} ${p.summary ?? ""}`;
  if (e.kind === "session.question") return p.questions?.map((q: any) => q.question).join(" | ") ?? "";
  if (typeof p.text === "string") return p.text.replace(/\s+/g, " ").slice(0, 160);
  return JSON.stringify(p).slice(0, 160);
}

const help = await import("./help.ts");
type ModuleHelp = import("./help.ts").ModuleHelp;

/** The modules on the box and what `pai <module> …` accepts, for the help and the completion. */
async function moduleHelp(): Promise<ModuleHelp[]> {
  const data = await api("/modules").catch(() => undefined);
  const ext = Array.isArray(data) ? data.filter((m: any) => m.external) : [];
  return ext.map((m: any) => ({ name: m.name, description: m.description ?? "", commands: (m.commands ?? []).map((x: any) => ({ name: x.name.split(" ")[0] === x.name ? x.name : x.name.split(" ")[0], args: x.name.includes(" ") ? x.name.slice(x.name.indexOf(" ") + 1) : x.args, description: x.description })) }));
}

interface ThreadRow {
  sessionId: string;
  shortId: string;
  title: string;
  project: string | null;
  cwd: string;
  state: string;
  lastActivity: number;
  parent?: string | null;
  modelPref?: string | null;
}

/** Live sessions over the ones held on disk, one row each, roots only. */
async function listThreads(only?: string): Promise<ThreadRow[]> {
  const [tasks, disk] = await Promise.all([api("/tasks"), api("/threads/all?per=15")]);
  const byId = new Map<string, ThreadRow>();
  for (const t of disk) byId.set(t.sessionId, { ...t, state: "held", lastActivity: Date.parse(t.lastActivity) });
  for (const t of [...tasks.recent, ...tasks.live]) byId.set(t.sessionId, { ...byId.get(t.sessionId), ...t, state: t.waiting ? "waiting" : t.state });
  return [...byId.values()].filter((t) => !t.parent && (!only || (t.project ?? "general") === only));
}

function groupThreads(rows: ThreadRow[]) {
  const rank = (t: ThreadRow) => (t.state === "waiting" ? 0 : t.state === "busy" || t.state === "starting" ? 1 : 2);
  const groups = new Map<string, ThreadRow[]>();
  for (const t of rows) groups.set(t.project ?? "general", [...(groups.get(t.project ?? "general") ?? []), t]);
  for (const threads of groups.values()) threads.sort((a, b) => rank(a) - rank(b) || b.lastActivity - a.lastActivity);
  const latest = (threads: ThreadRow[]) => Math.max(...threads.map((t) => t.lastActivity));
  return new Map([...groups.entries()].sort(([a, x], [b, y]) => (a === "general" ? -1 : b === "general" ? 1 : latest(y) - latest(x))));
}

function threadLine(t: ThreadRow) {
  const age = (ms: number) => {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    return s < 60 ? "now" : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
  };
  return `${t.shortId}  ${t.state.padEnd(8)} ${age(t.lastActivity).padStart(4)}  ${String(t.title).replace(/\s+/g, " ").slice(0, 60)}`;
}

async function claude(args: string[], cwd: string) {
  const bin = Bun.which("claude") ?? `${process.env.HOME}/.local/bin/claude`;
  if (!(await Bun.file(bin).exists())) {
    console.error("installing claude…");
    const install = Bun.spawn(["sh", "-c", "curl -fsSL https://claude.ai/install.sh | bash"], { stdio: ["ignore", "inherit", "inherit"] });
    if ((await install.exited) !== 0) throw new Error("claude did not install; see https://docs.claude.com/en/docs/claude-code/setup");
  }
  // The pai channel: what is typed for this conversation in Paigram arrives here.
  const { channelArgs } = await import("./channel.ts");
  return Bun.spawn([bin, ...channelArgs(), ...args], { cwd, stdio: ["inherit", "inherit", "inherit"] }).exited;
}

/** The daemon hands the thread over (its transcript in place, its process stopped), then claude continues it here. */
async function resumeThread(id: string, extra: string[]) {
  const thread = (await listThreads()).find((t) => t.sessionId === id || t.shortId === id || t.sessionId.startsWith(id));
  const handed = await post("/attach", { id: thread?.sessionId ?? id, cwd: thread?.cwd, force: extra.includes("--force") });
  if (handed.error) throw new Error(handed.error);
  const flags = thread?.modelPref ? ["--model", thread.modelPref] : [];
  return claude(["--resume", handed.id, ...flags, ...extra.filter((a) => a !== "--force")], handed.cwd);
}

async function userCommand() {
  switch (cmd) {
    // `pai ssh` is a shell on the box; `pai ssh <command>` runs that there and comes back.
    case "ssh":
    case "connect": {
      if (!box) throw new Error("no box configured: set PAI_REMOTE=user@host in .env");
      if (!remoteBox) throw new Error(`${box.target} is this machine`);
      process.exit(await r.ssh(remoteBox, positional.length ? positional.join(" ") : undefined));
    }
    // A conversation with the assistant, in this terminal: a new one each time, in the
    // workspace (its persona, its memory); `--resume` is claude's own picker of earlier ones.
    // From a laptop that is the same command on the box over ssh.
    // `--resume <id>` is one of pai's threads: it continues in that thread's directory with its
    // model, after the daemon lets go of it.
    case "claude": {
      if (remoteBox) process.exit(await r.ssh(remoteBox, ["pai", "claude", ...args].map(r.quote).join(" ")));
      const at = args.indexOf("--resume");
      const id = at >= 0 && args[at + 1] && !args[at + 1]!.startsWith("-") ? args[at + 1]! : undefined;
      process.exit(id ? await resumeThread(id, args.filter((_, i) => i !== at && i !== at + 1)) : await claude(args, config.workspace));
    }
    // The MCP server `claude` starts in a terminal (see channel.ts); `install` makes `claude` in this shell load it.
    case "channel": {
      const channel = await import("./channel.ts");
      if (positional[0] === "install") return console.log(`claude in ${channel.install()} now loads the pai channel; open a new shell`);
      return channel.run({ base, auth });
    }
    case "status": {
      const data = await api("/health");
      out(data, () => statusLines(data, remoteBox ? "box" : "here").join("\n"));
      break;
    }
    case "sync":
    case "fs":
    case "files": {
      const f = await import("../host/files.ts");
      if (!remoteBox) throw new Error("file sync runs on the laptop, against the box");
      const sub = cmd === "sync" ? "watch" : (positional[0] ?? "status");
      const made = await f.ensureSessions();
      if (made.length) console.error(`started syncing ${made.join(", ")}`);
      const winner = args.includes("--local") ? "local" : args.includes("--remote") ? "remote" : undefined;
      const show = async () => out(await f.status(), () => filesLines(current!));
      let current: Awaited<ReturnType<typeof f.status>> | undefined;
      const refresh = async () => (current = await f.status());
      switch (sub) {
        case "status":
          await refresh();
          await show();
          break;
        case "watch": {
          if (positional[1] === "on") return void out(await f.resume(), () => "watching");
          if (positional[1] === "off") return void out(await f.pause(), () => "paused; `pai files watch on` to resume");
          // A live view that leaves once everything is in sync (--forever stays); without a terminal, one reading.
          if (!process.stdout.isTTY || jsonOut) {
            await refresh();
            await show();
            break;
          }
          await (await import("./files-ui.tsx")).watch(args.includes("--forever"));
          break;
        }
        case "on":
          out(await f.resume(), () => "watching");
          break;
        case "off":
          out(await f.pause(), () => "paused; `pai files on` to resume");
          break;
        case "sync":
        case "push":
        case "pull": {
          const take = sub === "push" ? "local" : sub === "pull" ? "remote" : winner;
          await refresh();
          const conflicts = current!.flatMap((x) => x.conflicts.map((c) => `${x.name}: ${c.path} (here ${c.local}, box ${c.remote})`));
          if (conflicts.length && !take) {
            console.error(`${conflicts.length} conflict${conflicts.length > 1 ? "s" : ""} — nothing changed. --local keeps this machine's version, --remote the box's:\n  ${conflicts.join("\n  ")}`);
            process.exit(1);
          }
          const settled = take ? await f.resolve(take) : [];
          await f.flush();
          // A first sync with its conflicts settled becomes an ordinary one now rather than on the next command.
          const promoted = await f.ensureSessions();
          if (promoted.length) console.error(`first sync done: ${promoted.join(", ")} now settle on their own`);
          await refresh();
          out({ settled, folders: current }, () => [...(settled.length ? [`settled ${settled.length} in favour of ${take === "local" ? "this machine" : "the box"}:`, ...settled.map((x) => `  ${x}`), ""] : []), filesLines(current!)].join("\n"));
          break;
        }
        case "diff": {
          // `diff` prints every conflict as a unified diff; `diff tree` walks them in a terminal; `diff <path>` is one.
          const ui = await import("./files-ui.tsx");
          if (positional[1] === "tree") {
            if (!process.stdout.isTTY) throw new Error("`diff tree` needs a terminal; `pai files diff` prints them");
            if (!(await ui.tree())) console.log("no conflicts");
            break;
          }
          await refresh();
          const want = positional[1];
          const pairs = current!.flatMap((x) => x.conflicts.filter((c) => !want || c.path === want || c.path.endsWith(`/${want}`)).map((c) => ({ folder: x.name, ...c })));
          if (jsonOut) {
            const withText = [];
            for (const p of pairs) withText.push({ ...p, diff: await f.diff(p.folder, p.path) });
            console.log(JSON.stringify(withText, null, 2));
            break;
          }
          if (!pairs.length) {
            console.log(want ? `no conflict at ${want}` : "no conflicts");
            break;
          }
          const colour = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
          for (const p of pairs) {
            console.log(`${help.c.head(p.path)}  ${help.c.dim(`here ${p.local} · box ${p.remote}`)}`);
            console.log((await f.diff(p.folder, p.path, colour)).trimEnd() || help.c.dim("  (identical now)"));
            console.log();
          }
          break;
        }
        case "reset":
          await f.reset();
          out({ reset: true }, () => "history forgotten; the next cycle re-reads both sides");
          break;
        default:
          console.log(help.section("files", help.FILES));
      }
      break;
    }
    // The box pulls what its channel says is new and restarts; this checkout, when it is a
    // laptop's, is pulled too and its menu bar app rebuilt.
    case "update": {
      const there = await post("/update", {}).catch(async (err: Error) => {
        if (!err.message.includes("Unable to connect") || remoteBox) throw err;
        return (await import("../host/update.ts")).update();
      });
      const here = remoteBox ? await (await import("../host/client.ts")).update() : undefined;
      out({ box: there, client: here }, () => [`${remoteBox ? "box   " : "here  "}${updateLine(there)}`, ...(here ? [`client ${here.head}${here.updated ? " — updated" : " — up to date"}`] : [])].join("\n"));
      break;
    }
    // What runs the assistant costs: the Claude subscription's windows and the box.
    case "cost": {
      const claude = await usageWithLogin();
      const box = await api("/cost");
      out({ claude, box }, () => [...usageLines(claude), "", ...costLines(box)].join("\n"));
      break;
    }
    case "menubar": {
      const m = await import("../host/menubar.ts");
      const sub = positional[0] ?? "status";
      if (sub === "install") out(await m.install(remoteBox ? await r.boxApi(remoteBox) : undefined), () => "menu bar app installed");
      else if (sub === "uninstall") out(await m.uninstall(), () => "menu bar app removed");
      else out(m.status(), () => (m.status().installed ? "installed" : "not installed (`pai menubar install`)"));
      break;
    }
    // Every conversation there is — running, waiting, held on disk — by project. In a terminal
    // it is a list to choose from; the choice continues in this terminal.
    case "projects":
    case "threads": {
      const threads = await listThreads(positional[0]);
      const groups = groupThreads(threads);
      if (jsonOut || !process.stdin.isTTY) {
        out([...groups.entries()].map(([project, threads]) => ({ project, threads })), () =>
          [...groups.entries()].map(([project, threads]) => [project, ...threads.map((t) => `  ${threadLine(t)}`)].join("\n")).join("\n\n"),
        );
        break;
      }
      const { pick } = await import("./picker.ts");
      const chosen = await pick(
        [...groups.entries()].flatMap(([project, threads]) => threads.map((t) => ({ group: project, value: t, text: `${project} ${t.title} ${t.shortId}`, line: threadLine(t) }))),
        "type to filter · enter opens · esc leaves",
      );
      if (!chosen) break;
      if (remoteBox) process.exit(await r.ssh(remoteBox, ["pai", "claude", "--resume", chosen.sessionId].map(r.quote).join(" ")));
      process.exit(await resumeThread(chosen.sessionId, []));
    }
    // What the sessions are given, one kind at a time; `GET /context` is the one source.
    case "tools":
    case "skills":
    case "instructions":
    case "memories": {
      const kind = ({ tools: "tool", skills: "skill", instructions: "instruction", memories: "memory" } as const)[cmd];
      const data = await api("/context");
      const items = (data.items as any[]).filter((x) => x.kind === kind);
      const wanted = positional[0]?.toLowerCase();
      const chosen = wanted ? items.filter((x) => x.name.toLowerCase().includes(wanted) || (x.project ?? "").toLowerCase() === wanted) : items;
      if (wanted && !chosen.length) throw new Error(`no ${cmd} match "${positional[0]}"`);
      // A body is printed when asked for one thing, for memories (the content is the point), or with --full.
      const full = Boolean(wanted) || args.includes("--full") || cmd === "memories";
      const where = (x: any) => (x.surfaces.length ? x.surfaces.join(", ") : "nowhere");
      out(chosen, () =>
        chosen
          .map((x) => {
            const head = `${help.c.head(x.name)}  ${help.c.dim(`${x.description} · ${where(x)}`)}${x.editable ? `\n${help.c.dim(x.source)}` : ""}`;
            if (cmd === "tools") {
              const tools = (x.tools ?? []) as { name: string; description?: string }[];
              const w = Math.max(0, ...tools.map((t) => t.name.length));
              return `${head}\n${tools.map((t) => `  ${t.name.padEnd(w)}  ${help.c.dim((t.description ?? "").split("\n")[0]!.slice(0, 100))}`).join("\n")}`;
            }
            return full && x.body ? `${head}\n\n${x.body.trim()}\n` : head;
          })
          .join(full && cmd !== "tools" ? "\n" + "─".repeat(60) + "\n" : "\n"),
      );
      break;
    }
    case "modules": {
      const sub = positional[0] ?? "list";
      if (sub === "update") {
        const data = await api("/modules");
        const results: Record<string, unknown> = {};
        for (const m of data.filter((x: any) => x.external)) results[m.name] = await post(`/modules/${m.name}/update`, {});
        await post("/restart", {});
        out(results, () => [...Object.entries(results).map(([name, r]: [string, any]) => `${name.padEnd(12)} ${r.updated ? `${r.from} → ${r.to}` : (r.reason ?? "up to date")}`), "daemon restarting"].join("\n"));
        break;
      }
      if (sub === "restart") {
        out(await post("/restart", {}), () => "daemon restarting; modules reload with it");
        break;
      }
      const data = await api("/modules");
      const ext = data.filter((x: any) => x.external);
      out(data, () =>
        [
          ...ext.map((m: any) => `${m.name.padEnd(12)} ${(m.status.health.ok ? (m.status.started ? "running" : m.enabled ? "loaded" : "off") : "broken").padEnd(8)} ${m.status.source}${m.status.linked ? " (linked)" : ""}${m.status.health.detail ? ` — ${m.status.health.detail}` : ""}${m.status.cli ? "  · pai " + m.name : ""}`),
          ...(ext.length ? [""] : []),
          ...data.filter((x: any) => !x.external).map((m: any) => `${m.name.padEnd(12)} ${(m.enabled ? "on" : "off").padEnd(8)} built in`),
        ].join("\n"),
      );
      break;
    }
    case "version": {
      const here = (await Bun.file(`${config.repo}/package.json`).json()).version as string;
      const there = remoteBox ? await api("/health").then((h) => h.version as string).catch(() => "unreachable") : undefined;
      out({ here: `v${here}`, box: there }, () => [`here  v${here}`, ...(there ? [`box   ${there}`] : [])].join("\n"));
      break;
    }
    case "completion": {
      const script = help.zshCompletion(await moduleHelp());
      if (positional[0] === "zsh") {
        console.log(script);
        break;
      }
      const shell = (process.env.SHELL ?? "").split("/").pop();
      if (shell !== "zsh") throw new Error(`completion is zsh only; this shell is ${shell || "unknown"} (\`pai completion zsh\` prints the script)`);
      const { installCompletion } = await import("../host/client.ts");
      const result = await installCompletion(script);
      const messages = { current: "completion already installed", updated: "completion updated — this shell predates it: run `exec zsh` (or open a new tab)", installed: "completion installed — this shell predates it: run `exec zsh` (or open a new tab)" };
      out(result, (): string => messages[result.status]);
      break;
    }
    // pai and its staff, the way the chat would show them.
    case "agents": {
      const data = await api("/agents");
      out(data, () => agentTree(data).join("\n"));
      break;
    }
    case "log": {
      const agent = positional[0];
      const data = await api(`/messages?limit=${flag("limit") ?? 40}${agent ? `&agent=${agent}` : ""}`);
      out(data, () => data.map(logLine).join("\n") || "(nothing yet)");
      break;
    }
    case "tasks": {
      const [sub, ...rest] = positional;
      if (sub === "add") {
        const data = await post("/tasks", { title: rest.join(" "), owner: flag("owner"), due: flag("due") });
        out(data, () => data.error ?? taskLine(data));
        break;
      }
      if (sub === "done" || sub === "drop") {
        const data = await patch(`/tasks/${rest[0]}`, { status: sub === "done" ? "done" : "dropped" });
        out(data, () => data.error ?? taskLine(data));
        break;
      }
      const data = await api(`/tasks${args.includes("--all") ? "?all=1" : ""}${flag("owner") ? `${args.includes("--all") ? "&" : "?"}owner=${flag("owner")}` : ""}`);
      out(data.items, () => data.items.map(taskLine).join("\n") || "(nothing on the plate)");
      break;
    }
    case "asks": {
      const data = await api("/asks");
      out(data, () => data.map((a: any) => `#${a.id}  ${a.agent.padEnd(12)} ${a.question}${a.options.length ? `  [${a.options.join(" / ")}]` : ""}${a.delivered ? "" : "  (held)"}`).join("\n") || "(nothing waiting on you)");
      break;
    }
    case "answer": {
      const [id, ...rest] = positional;
      const data = await post(`/asks/${String(id).replace(/^#/, "")}/answer`, { text: rest.join(" ") });
      out(data, () => data.error ?? `answered #${data.id}`);
      break;
    }
    case "routines": {
      const data = await api("/routines");
      out(data, () => data.map((r: any) => `${String(r.id).padStart(3)}  ${r.enabled ? "on " : "off"} ${(r.schedule || r.event).padEnd(18)} ${r.action.padEnd(6)} ${(r.agent || "").padEnd(12)} ${r.name}  · ${r.runs} runs`).join("\n"));
      break;
    }
    case "recall": {
      const data = await api(`/recall?q=${encodeURIComponent(positional.join(" "))}`);
      out(data, () => (Array.isArray(data) && data.length && "snippet" in data[0] ? data.map((h: any) => `${h.at}  ${h.source.padEnd(10)} ${h.title}\n    ${h.snippet.replace(/\s+/g, " ")}`).join("\n") : data.map?.((s: any) => `${s.source.padEnd(12)} ${s.entries}`).join("\n") || "(nothing found)"));
      break;
    }
    case "dev":
      console.log(help.section("dev", help.DEV));
      break;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(help.usage(await moduleHelp()));
      break;
    default: {
      // A module's own command line: on the box it runs here; from a laptop it runs there,
      // except the subcommands a module wants on the laptop (a browser, its files).
      const external = await import("../modules/external.ts");
      if (remoteBox && !(await external.runsHere(cmd!, positional[0]))) process.exit(await r.ssh(remoteBox, ["pai", cmd, ...args].map(r.quote).join(" ")));
      const code = await external.runCli(cmd!, args, api, post, out, jsonOut);
      if (code === undefined) {
        console.log(help.usage(await moduleHelp()));
        process.exit(1);
      }
      process.exit(code);
    }
  }
}

const STATE_MARK: Record<string, string> = { idle: "○", queued: "◔", working: "●", waiting: "?", closed: "×" };

function agentTree(rows: any[]): string[] {
  const byParent = new Map<string | null, any[]>();
  for (const a of rows) byParent.set(a.parent, [...(byParent.get(a.parent) ?? []), a]);
  const lines: string[] = [];
  const walk = (parent: string | null, indent: string) => {
    for (const a of byParent.get(parent) ?? []) {
      const extra = [a.kind === "orchestrator" ? "" : a.kind, a.openTasks ? `${a.openTasks} open` : "", a.turnsToday ? `${a.turnsToday} turns today` : "", a.costUsd ? `$${a.costUsd.toFixed(2)}` : "", a.queued ? `${a.queued} queued` : "", a.unresolvedTools?.length ? `⚠ no server for ${a.unresolvedTools.join(", ")}` : ""].filter(Boolean).join(" · ");
      lines.push(`${indent}${STATE_MARK[a.status] ?? "·"} ${a.name.padEnd(Math.max(1, 16 - indent.length))} ${a.status.padEnd(8)} ${extra}`);
      walk(a.slug, `${indent}  `);
    }
  };
  walk(null, "");
  return lines;
}

function logLine(m: any) {
  const at = new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const arrow = m.kind === "event" ? `· ${m.meta?.event ?? "event"}` : `${m.from} → ${m.to}`;
  return `${at}  ${m.kind.padEnd(8)} ${arrow.padEnd(24)} ${m.body.replace(/\s+/g, " ").slice(0, 140)}`;
}

function taskLine(t: any) {
  return `#${String(t.id).padEnd(4)} ${t.status.padEnd(13)} ${t.owner.padEnd(12)} ${t.title}${t.due ? `  due ${t.due}` : ""}${t.nextAction ? `  → ${t.nextAction}` : ""}`;
}

/**
 * The limits, read by the box. A box that cannot read them (its own token is a setup token)
 * is given this laptop's Claude Code login from the keychain; a laptop without one is told
 * to sign in.
 */
async function usageWithLogin() {
  let data = await api("/usage");
  if (!data.needsLogin || !remoteBox) return data;
  const creds = await r.localClaudeLogin();
  if (!creds) return { ...data, error: `${data.error ?? "the box cannot read the limits"} — run \`claude\` here and /login, then \`pai cost\` again` };
  data = await api("/usage/credentials", { method: "POST", body: creds });
  if (!data.error) console.error("the box now has this machine's Claude login");
  return data;
}

const resetIn = (iso?: string) => {
  if (!iso) return "";
  const s = (Date.parse(iso) - Date.now()) / 1000;
  if (s <= 0) return "";
  if (s >= 86_400) return ` · resets in ${Math.round(s / 86_400)}d`;
  if (s >= 3600) return ` · resets in ${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
  return ` · resets in ${Math.max(1, Math.round(s / 60))}m`;
};

function usageLines(data: any) {
  const lines = ["claude"];
  for (const w of data.windows ?? []) lines.push(`  ${String(w.name).padEnd(12)} ${String(w.percent).padStart(3)}%${resetIn(w.resetsAt)}`);
  if (!data.windows?.length) lines.push(`  ${data.error ?? "no reading yet"}`);
  else if (data.error) lines.push(`  (${data.error})`);
  if (data.via) lines.push(`  read by ${data.via}`);
  if (typeof data.costUsd === "number") lines.push(`  ${"sessions".padEnd(12)} $${data.costUsd.toFixed(2)} across the daemon's sessions`);
  return lines;
}

function costLines(data: any) {
  if (data.error) return ["box", `  ${data.error}`];
  return ["box", ...data.lines.map((l: any) => `  ${l.name.padEnd(26)} ${l.monthly.toFixed(2)} ${data.currency}/mo`), `  ${"total".padEnd(26)} ${data.monthlyTotal.toFixed(2)} ${data.currency}/mo`];
}

function statusLines(data: any, label: string) {
  if (data.error) return [`${label.padEnd(9)} ${data.error}`];
  return [
    `${label.padEnd(9)} ${data.version} · ${data.host.hostname} (${data.host.platform}) · api ${data.host.api}`,
    `public    ${data.public?.url ?? "(off)"}${data.public?.state && data.public.state !== "up" ? ` — ${data.public.state}${data.public.reason ? `: ${data.public.reason}` : ""}` : ""}`,
    `editor    ${data.editor?.enabled ? `${data.editor.running ? "running" : "starting"} at ${data.editor.url}` : "off"}`,
    `projects  ${data.counts.projects}`,
  ];
}

const STATE: Record<string, string> = {
  watching: "in sync",
  scanning: "scanning",
  "staging-alpha": "sending",
  "staging-beta": "receiving",
  transitioning: "applying",
  connecting: "connecting",
  "connecting-alpha": "connecting",
  "connecting-beta": "connecting to the box",
  "waiting-for-rescan": "waiting",
  "halted-on-root-emptied": "halted: a root was emptied (pai files reset)",
  "halted-on-root-deletion": "halted: a root was deleted",
  "halted-on-root-type-change": "halted: a root changed type",
  missing: "not set up",
};

/** Like `git status`: a line per folder, then its conflicts and problems indented, coloured on a terminal. */
function filesLines(folders: any[]) {
  const { c } = help;
  const paint = (x: any) => (x.paused ? c.args : x.state === "watching" ? (x.conflicts.length ? paintRed : c.command) : x.state.startsWith("halted") ? paintRed : c.pai);
  return folders
    .map((x) => {
      const state = x.paused ? "paused" : (STATE[x.state] ?? x.state);
      const mark = x.paused ? "⏸" : x.state === "watching" ? (x.conflicts.length ? "!" : "✓") : x.state.startsWith("halted") || x.state === "missing" ? "✗" : "…";
      const facts = [x.files !== undefined && `${x.files.toLocaleString("en-US")} files`, x.cycles !== undefined && `${x.cycles} cycles`, x.progress && `${x.progress.total ? Math.round((x.progress.done / x.progress.total) * 100) : 0}% ${x.progress.path}`].filter(Boolean).join(" · ");
      const head = `${paint(x)(mark)} ${c.head(x.local.replace(process.env.HOME ?? "", "~").padEnd(12))} ${paint(x)(state)}${facts ? c.dim(`  ${facts}`) : ""}${x.error ? paintRed(`  ${x.error}`) : ""}`;
      const lines = [head];
      if (x.conflicts.length) {
        lines.push(paintRed(`  ${x.conflicts.length} conflict${x.conflicts.length > 1 ? "s" : ""}`) + c.dim("  (pai files diff; sync --local or --remote settles)"));
        for (const k of x.conflicts.slice(0, 12)) lines.push(`    ${k.local === "deleted" ? paintRed("−") : k.remote === "deleted" ? c.command("+") : c.args("±")} ${k.path}${c.dim(`  here ${k.local} · box ${k.remote}`)}`);
        if (x.conflicts.length > 12) lines.push(c.dim(`    … ${x.conflicts.length - 12} more (pai files diff tree)`));
      }
      if (x.problems?.length) {
        lines.push(c.args(`  ${x.problems.length} problem${x.problems.length > 1 ? "s" : ""}`) + c.dim("  (skipped, not synced)"));
        for (const p of x.problems.slice(0, 6)) lines.push(`    ${c.dim(p.side.padEnd(4))} ${p.path}${c.dim(`  ${p.error}`)}`);
        if (x.problems.length > 6) lines.push(c.dim(`    … ${x.problems.length - 6} more (--json lists all)`));
      }
      return lines.join("\n");
    })
    .join("\n");
}
const paintRed = (s: string) => (process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[31m${s}\x1b[0m` : s);

const updateLine = (data: any) =>
  data.error
    ? data.error
    : data.updated
      ? `updated to ${data.head}${data.restarting ? " — restarting" : ""}`
      : `${data.head} on ${data.branch} · ${data.behind} behind${data.dirty ? " · dirty" : ""}${data.reason ? ` · ${data.reason}` : ""}`;

async function devCommand() {
  switch (cmd) {
    case "daemon": {
      if (foreground) {
        await import("../daemon.ts");
        break;
      }
      // Detached, so the terminal comes back; it keeps the port until it is killed.
      const log = `${config.repo}/data/daemon.log`;
      const file = Bun.file(log);
      const child = Bun.spawn([process.execPath, "run", `${config.repo}/src/daemon.ts`], {
        cwd: config.repo,
        stdout: file,
        stderr: file,
        stdin: "ignore",
        env: process.env,
      });
      child.unref();
      out({ pid: child.pid, log }, () => `daemon ${child.pid} — ${log} (--foreground to stay attached)`);
      break;
    }
    case "update": {
      // Works with the daemon down too — then the update just runs here.
      const local = async () => {
        const u = await import("../host/update.ts");
        return args.includes("--check") ? u.status() : u.update(args.includes("--force"));
      };
      const remote = () =>
        args.includes("--check") ? api("/update") : post("/update", { force: args.includes("--force") });
      const data = await remote().catch((err: Error) => {
        if (!err.message.includes("Unable to connect")) throw err;
        return local();
      });
      out(data, () =>
        data.updated
          ? `updated to ${data.head}${data.restarting ? " — daemon restarting" : ""}`
          : `${data.head} on ${data.branch} · ${data.behind} behind${data.dirty ? " · dirty" : ""}${data.reason ? ` · ${data.reason}` : ""}`,
      );
      break;
    }
    case "install":
      await import("../host/install-daemon-linux.ts");
      break;
    case "say": {
      const data = await post("/pai", { text: positional.join(" "), wait: true });
      out(data, () => data.text || (data.error ?? "(no reply)"));
      break;
    }
    case "rotate":
      out(await post("/pai/rotate", {}));
      break;
    case "chat": {
      const data = await post("/chat", { text: positional.join(" "), id: flag("id") });
      out(data, () => data.text || (data.error ?? "(no reply)"));
      break;
    }
    case "task": {
      const [title, ...rest] = positional;
      const data = await post("/task", { title, text: rest.join(" "), project: flag("project") });
      out(data, () => `${data.shortId} ${data.kind} "${data.title}" ${data.state}`);
      break;
    }
    case "send": {
      const [id, ...rest] = positional;
      const data = await post("/send", { id, text: rest.join(" "), wait: args.includes("--wait") });
      out(data, () => (data.text !== undefined ? data.text : `${data.shortId} ${data.state}`));
      break;
    }
    case "answer": {
      const [id, ...rest] = positional;
      out(await post("/answer", { id, text: rest.join(" ") }));
      break;
    }
    case "tasks": {
      const data = await api("/sessions");
      out(data, () =>
        data.recent.length
          ? data.recent
              .map((t: any) => `${t.shortId}  ${t.state.padEnd(9)} ${t.kind.padEnd(5)} ${t.title.slice(0, 40).padEnd(40)} $${t.costUsd.toFixed(2)}  ${t.lastResult.replace(/\s+/g, " ").slice(0, 60)}`)
              .join("\n")
          : "(none)",
      );
      break;
    }
    case "stop":
      out(await post("/stop", { id: positional[0], kill: args.includes("--kill") }));
      break;
    case "tail":
      await follow(positional[0], args.includes("--raw"));
      break;
    case "events": {
      const data = await api(`/events${positional[0] ? `?session=${positional[0]}` : ""}`);
      out(data, () => data.map((e: any) => `${clock(e.ts)} ${(e.sessionId ?? "").slice(0, 6).padEnd(6)} ${e.kind.padEnd(18)} ${summarize(e)}`).join("\n"));
      break;
    }
    case "settings": {
      const changes = Object.fromEntries(positional.filter((a) => a.includes("=")).map((a) => a.split(/=(.*)/s).slice(0, 2)));
      if (Object.keys(changes).length) {
        const data = await patch("/settings", changes);
        out(data, () => `${Object.keys(changes).join(", ")} written; restart the daemon to apply (\`pai restart\`)`);
        break;
      }
      const data = await api("/settings");
      out(data, () =>
        data.editable
          .map((key: string) => `${key.padEnd(24)} ${data.effective[key] || "(unset)"}${key in data.overrides ? "  *" : ""}`)
          .join("\n"),
      );
      break;
    }
    case "restart": {
      const data = await post("/restart", {});
      out(data, () => "restarting");
      break;
    }
    default:
      console.log(help.section("dev", help.DEV));
  }
}

try {
  await (dev ? devCommand() : userCommand());
} catch (err) {
  console.error(`error: ${(err as Error).message}`);
  if ((err as Error).message.includes("Unable to connect")) console.error("is the daemon running? `pai dev daemon`");
  process.exit(1);
}
