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
const VALUED = new Set(["--id", "--project", "--limit", "--owner", "--due", "--q", "--by"]);
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

const raw = (path: string, init?: RequestInit) => fetch(base + path, { ...init, headers: { ...auth, ...(init?.headers as Record<string, string>) } });

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
  return ext.map((m: any) => ({ name: m.name, description: m.description ?? "", verbs: m.verbs ?? [], commands: (m.commands ?? []).map((x: any) => ({ name: x.name.split(" ")[0] === x.name ? x.name : x.name.split(" ")[0], args: x.name.includes(" ") ? x.name.slice(x.name.indexOf(" ") + 1) : x.args, description: x.description })) }));
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

/** `dev channel args`: what `claude` needs to load dev's channel, when dev is installed on this machine. */
function devChannelArgs(): string[] {
  const bin = Bun.which("dev") ?? `${process.env.HOME}/.local/bin/dev`;
  const res = Bun.spawnSync([bin, "channel", "args"], { stdout: "pipe", stderr: "ignore" });
  try {
    return res.exitCode === 0 ? (JSON.parse(res.stdout.toString()) as string[]) : [];
  } catch {
    return [];
  }
}

async function claude(args: string[], cwd: string) {
  const bin = Bun.which("claude") ?? `${process.env.HOME}/.local/bin/claude`;
  if (!(await Bun.file(bin).exists())) {
    console.error("installing claude…");
    const install = Bun.spawn(["sh", "-c", "curl -fsSL https://claude.ai/install.sh | bash"], { stdio: ["ignore", "inherit", "inherit"] });
    if ((await install.exited) !== 0) throw new Error("claude did not install; see https://docs.claude.com/en/docs/claude-code/setup");
  }
  // dev's channel: what is typed for this conversation in Paigram arrives here.
  const extra = devChannelArgs();
  return Bun.spawn([bin, ...extra, ...args], { cwd, stdio: ["inherit", "inherit", "inherit"] }).exited;
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
    case "status": {
      const data = await api("/health");
      out(data, () => statusLines(data, remoteBox ? "box" : "here").join("\n"));
      break;
    }
    // What runs the assistant costs: the Claude subscription's windows and the box.
    case "cost": {
      const claude = await usageWithLogin();
      const box = await api("/cost");
      const spend = await api(`/spend?days=${Number(positional[0]) || 30}`);
      out({ claude, box, spend }, () => [...usageLines(claude), "", ...costLines(box), "", ...spendLines(spend, flag("by") ?? "agent")].join("\n"));
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
          .join(full && cmd !== "tools" ? `\n${"─".repeat(60)}\n` : "\n"),
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
          ...ext.map((m: any) => `${m.name.padEnd(12)} ${(m.status.health.ok ? (m.status.started ? "running" : m.enabled ? "loaded" : "off") : "broken").padEnd(8)} ${m.status.source}${m.status.linked ? " (linked)" : ""}${m.status.health.detail ? ` — ${m.status.health.detail}` : ""}${m.status.cli ? `  · pai ${m.name}` : ""}`),
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
      const { installCompletion } = await import("./completion.ts");
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
    case "snapshot": {
      const [what = "export", file] = positional;
      if (what === "import") {
        if (!file) throw new Error("pai snapshot import <file>");
        const data = await post("/snapshot", { text: await Bun.file(String(file)).text() });
        out(data, () => data.error ?? `handed to pai (session ${data.session})`);
        break;
      }
      const data = await api("/snapshot");
      if (file) {
        await Bun.write(String(file), data.text);
        console.log(`written ${file}`);
      } else out(data, () => data.text);
      break;
    }
    case "audit": {
      const agent = positional[0];
      const data = await api(`/audit?limit=${flag("limit") ?? 40}${agent ? `&agent=${encodeURIComponent(agent)}` : ""}${flag("q") ? `&q=${encodeURIComponent(flag("q")!)}` : ""}`);
      out(data, () => data.map(auditLine).join("\n") || "(nothing done outside yet)");
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
    case "update":
      process.exit(await (await import("./update.ts")).updateCommand({ api, post, out }, args));
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(help.usage(await moduleHelp()));
      break;
    default: {
      // A connector's own command line (`pai <connector> …`).
      if (!(await runModule(cmd!, args, positional[0]))) {
        console.log(help.usage(await moduleHelp()));
        process.exit(1);
      }
    }
  }
}

/**
 * A connector's command line: on the box it runs here; from a laptop it runs there, except what the connector wants on
 * the laptop (`cliHere`: a browser, its files). False when no connector of that name is configured.
 */
async function runModule(name: string, cliArgs: readonly string[], sub: string | undefined): Promise<boolean> {
  const external = await import("../connectors/loader.ts");
  if (remoteBox && !(await external.runsHere(name, sub))) process.exit(await r.ssh(remoteBox, ["pai", ...argv].map(r.quote).join(" ")));
  const code = await external.runCli(name, cliArgs, { api, post, fetch: raw, out, json: jsonOut });
  if (code === undefined) return false;
  process.exit(code);
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

function auditLine(e: any) {
  const at = new Date(e.ts).toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const mark = e.ok === null ? "…" : e.ok ? "✓" : "✗";
  return `${at}  ${mark} ${(e.agent ?? "thread").padEnd(12)} ${e.summary.replace(/\s+/g, " ").slice(0, 140)}`;
}

function taskLine(t: any) {
  return `#${String(t.id).padEnd(4)} ${t.status.padEnd(13)} ${t.owner.padEnd(12)} ${t.title}${t.due ? `  due ${t.due}` : ""}${t.nextAction ? `  → ${t.nextAction}` : ""}`;
}

/**
 * The limits, read by the box with its own login. A laptop's login is never copied over: a refresh
 * token is single-use, so two machines sharing one sign each other out.
 */
async function usageWithLogin() {
  const data = await api("/usage");
  if (!data.needsLogin || !remoteBox) return data;
  return { ...data, error: `${data.error ?? "the box cannot read the limits"} — reconnect its Claude login at ${(await r.boxApi(remoteBox)).url}/claude/login` };
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

const usd = (n: number) => `$${n < 10 ? n.toFixed(2) : Math.round(n).toLocaleString("en-US")}`;
const tokens = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const hours = (ms: number) => (ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)}h` : `${Math.round(ms / 60_000)}m`);

/** Where it went: API price beside the real one (the plan spread by use, plus what was metered), then one group. */
function spendLines(data: any, by: string) {
  if (data.error) return ["spend", `  ${data.error}`];
  const t = data.total;
  const box = data.box?.periodUsd ?? 0;
  const metered = data.by.source.filter((b: any) => b.key === "gateway").reduce((sum: number, b: any) => sum + b.realUsd, 0);
  const lines = [
    `spend, last ${data.days} days`,
    `  ${"at API prices".padEnd(18)} ${usd(t.apiUsd)}`,
    `  ${"actually paid".padEnd(18)} ${usd(t.realUsd + box)}  (Claude ${data.plan.tier?.replace(/^default_claude_/, "").replace(/_/g, " ") ?? "plan"} ${usd(data.plan.periodUsd)} of ${usd(data.plan.monthlyUsd)}/mo, metered ${usd(metered)}${data.box ? `, box ${usd(box)}` : ""})`,
    `  ${"saved".padEnd(18)} ${usd(t.savedUsd)}`,
    ...(data.credits?.monthlyUsd ? [`  ${"API credits".padEnd(18)} ${usd(data.credits.usedUsd)} of ${usd(data.credits.monthlyUsd)}/mo (included in the plan)`] : []),
    `  ${"tokens".padEnd(18)} ${tokens(t.input + t.cacheWrite)} in · ${tokens(t.cacheRead)} cached · ${tokens(t.output)} out · ${t.calls} calls · ${hours(t.ms)} in turns`,
  ];
  const rows = by === "day" ? [...data.daily].reverse() : data.by[by];
  if (!rows) return [...lines, `  (no grouping "${by}": agent, project, model, source, day)`];
  lines.push("", `by ${by}`.padEnd(30) + "api".padStart(9) + "real".padStart(9) + "tokens".padStart(9) + "time".padStart(8));
  for (const b of rows.slice(0, 25))
    lines.push(`  ${String(b.key).slice(0, 26).padEnd(28)}${usd(b.apiUsd).padStart(9)}${usd(b.realUsd).padStart(9)}${tokens(b.input + b.output + b.cacheRead + b.cacheWrite).padStart(9)}${(b.ms ? hours(b.ms) : "").padStart(8)}`);
  return lines;
}

function statusLines(data: any, label: string) {
  if (data.error) return [`${label.padEnd(9)} ${data.error}`];
  return [
    `${label.padEnd(9)} ${data.version} · ${data.host.hostname} (${data.host.platform}) · api ${data.host.api}`,
    `projects  ${data.counts.projects}`,
  ];
}

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
    case "install":
      process.exit(await (await import("./install.ts")).installCommand(args));
    case "release":
      process.exit(await (await import("./release.ts")).releaseCommand(args));
    case "update":
      process.exit(await (await import("./update.ts")).updateCommand({ api, post, out }, args));
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
