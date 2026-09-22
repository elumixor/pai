#!/usr/bin/env bun
export {}; // dynamic imports only, but top-level await needs this file to be a module
const argv = process.argv.slice(2);
// `pai dev <command>` are the daemon's own controls; everything else is what a person uses.
const dev = argv[0] === "dev";
const [cmd, ...args] = dev ? argv.slice(1) : argv;

// The foreground daemon is the dev loop: verbose, and no bot fighting the installed one for the token.
// These have to be set before config.ts is evaluated, so config is imported after.
const foreground = args.includes("--foreground") || args.includes("-f");
if (dev && cmd === "daemon" && foreground) {
  process.env.PAI_NO_TELEGRAM ??= "1";
  process.env.PAI_VERBOSE ??= "1";
}
const { config } = await import("../core/config.ts");
const base = `http://${config.host}:${config.port}`;
const jsonOut = args.includes("--json");
const positional = args.filter((a) => !a.startsWith("--"));
const box = (await import("../host/remote.ts")).remote();
const remoteBox = box && !(await import("../host/remote.ts")).isHere(box) ? box : undefined;

function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

// The daemon may be bound to an address other than loopback, where its own token applies.
const auth: Record<string, string> = config.token ? { authorization: `Bearer ${config.token}` } : {};

async function api(path: string, init?: RequestInit) {
  const res = await fetch(base + path, { ...init, headers: { ...auth, ...(init?.headers as Record<string, string>) } });
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

const usage = `pai — the assistant on the box, from here

  claude [claude args…]   the main conversation in this terminal
  ssh [command…]          a shell on the box, or one command there (connect is the same)
  status                  this machine and the box: version, address, sync
  sync                    file sync with the box; pairs the two machines if they are not yet
  update                  update pai here and on the box
  cost                    what the box costs per month, priced from Hetzner

  --json on any command for raw output`;

const devUsage = `pai dev — the daemon's own controls, for working on pai

  chat <text>                  a turn in the main conversation — the same path as Telegram
  task <title> <text>          start a task (own context, own topic) — --project <slug> for coding work
  send <id> <text>             send a turn to a task; --wait for its reply
  answer <id> <text>           answer a task's pending question
  tasks                        running and recent tasks
  stop <id|main> [--kill]      interrupt (or kill) a session
  reset                        forget the main conversation
  tail [id] [--raw]            follow the event stream
  events [id]                  recent events
  projects [--refresh]         coding projects as the assistant sees them
  settings [KEY=value …]       read or change the daemon's settings; a change needs a restart
  restart                      restart the daemon
  memory [query]               what the assistant remembers; a query searches
  daemon [--foreground]        start the daemon; --foreground stays attached, verbose, no telegram
  install [--uninstall]        the service (launchd / systemd) + \`pai\` on PATH
  update [--check] [--force]   this daemon only: pull, reinstall, rebuild, restart`;

const remoteNote = (access: { changed: boolean; ip?: string }) => {
  if (access.changed) console.error(`firewall: port 22 now open for ${access.ip}`);
};

async function userCommand() {
  switch (cmd) {
    // `pai ssh` is a shell on the box; `pai ssh <command>` runs that there and comes back.
    case "ssh":
    case "connect": {
      const r = await import("../host/remote.ts");
      if (!box) throw new Error("no box configured: set PAI_REMOTE=user@host in .env");
      if (!remoteBox) throw new Error(`${box.target} is this machine`);
      remoteNote(await r.ensureAccess());
      process.exit(await r.ssh(remoteBox, positional.length ? positional.join(" ") : undefined));
    }
    // The main conversation, interactively. From a laptop that is the same command on the
    // box over ssh; on the box it is `claude --resume` in the workspace, with the daemon's
    // process for that conversation stopped so the two never write one transcript at once.
    case "claude": {
      const r = await import("../host/remote.ts");
      const rest = args.filter((a) => a !== "--force");
      if (remoteBox) {
        remoteNote(await r.ensureAccess());
        process.exit(await r.ssh(remoteBox, ["pai", "claude", ...args].map(r.quote).join(" ")));
      }
      const attach = await post("/attach", { force: args.includes("--force") });
      if (attach.error) throw new Error(attach.error);
      const bin = Bun.which("claude") ?? `${process.env.HOME}/.local/bin/claude`;
      if (!(await Bun.file(bin).exists())) {
        console.error("installing claude…");
        const install = Bun.spawn(["sh", "-c", "curl -fsSL https://claude.ai/install.sh | bash"], { stdio: ["ignore", "inherit", "inherit"] });
        if ((await install.exited) !== 0) throw new Error("claude did not install; see https://docs.claude.com/en/docs/claude-code/setup");
      }
      const mode = attach.fresh ? ["--session-id", attach.id] : ["--resume", attach.id];
      const proc = Bun.spawn([bin, ...mode, ...rest], { cwd: attach.cwd, stdio: ["inherit", "inherit", "inherit"] });
      const code = await proc.exited;
      // Nothing was said in a conversation that did not exist yet: forget it, or the daemon
      // would try to resume a transcript that is not there.
      if (attach.fresh) {
        const said = await api(`/transcript?session=${attach.id}&limit=1`).catch(() => []);
        if (!Array.isArray(said) || !said.length) await post("/reset", {});
      }
      process.exit(code);
    }
    case "status": {
      const here = await api("/health");
      const there = remoteBox ? await boxCall("status").catch((err: Error) => ({ error: err.message })) : undefined;
      out({ here, box: there }, () => [...statusLines(here, "here"), ...(there ? ["", ...statusLines(there, "box")] : [])].join("\n"));
      break;
    }
    // Sync is between this machine and the box. Both daemons run Syncthing; pairing is each
    // one being told the other's device id, which this does by itself over ssh.
    case "sync": {
      const here = await api("/sync");
      const there = remoteBox ? await boxCall("sync") : undefined;
      let paired = false;
      if (there && here.deviceId && there.deviceId && (here.peer !== there.deviceId || there.peer !== here.deviceId)) {
        const r = await import("../host/remote.ts");
        await patch("/settings", { PAI_SYNC: "1", PAI_SYNC_PEER: there.deviceId });
        await r.sshCapture(remoteBox!, `pai dev settings PAI_SYNC=1 PAI_SYNC_PEER=${here.deviceId} && pai dev restart`);
        await post("/restart", {});
        paired = true;
      }
      out({ here, box: there, paired }, () =>
        [
          ...(paired ? ["paired this machine with the box; both daemons are restarting", ""] : []),
          ...syncLines(here, "here"),
          ...(there ? ["", ...syncLines(there, "box")] : ["", `box       ${box ? "(this machine)" : "(none configured)"}`]),
        ].join("\n"),
      );
      break;
    }
    // Here first, then the box: each daemon pulls what its channel says is new and restarts.
    case "update": {
      const here = await post("/update", {}).catch(async (err: Error) => {
        if (!err.message.includes("Unable to connect")) throw err;
        return (await import("../host/update.ts")).update();
      });
      const there = remoteBox ? await boxCall("update").catch((err: Error) => ({ error: err.message })) : undefined;
      out({ here, box: there }, () => [`here  ${updateLine(here)}`, ...(there ? [`box   ${updateLine(there)}`] : [])].join("\n"));
      break;
    }
    case "cost": {
      const data = await api("/cost");
      out(data, () =>
        data.error
          ? data.error
          : [
              ...data.lines.map((l: any) => `${l.name.padEnd(28)} ${l.monthly.toFixed(2)} ${data.currency}/mo`),
              `${"total".padEnd(28)} ${data.monthlyTotal.toFixed(2)} ${data.currency}/mo`,
            ].join("\n"),
      );
      break;
    }
    case "dev":
      console.log(devUsage);
      break;
    default:
      console.log(usage);
  }
}

/** The same `pai` command on the box, its JSON. The box answers for itself, not for this machine. */
async function boxCall(command: string) {
  const r = await import("../host/remote.ts");
  remoteNote(await r.ensureAccess());
  return r.boxJson(remoteBox!, command === "sync" || command === "status" ? command : `dev ${command}`);
}

function statusLines(data: any, label: string) {
  if (data.error) return [`${label.padEnd(9)} ${data.error}`];
  return [
    `${label.padEnd(9)} ${data.version} · ${data.host.hostname} (${data.host.platform}) · api ${data.host.api}`,
    `public    ${data.public?.url ?? "(off)"}${data.public?.state && data.public.state !== "up" ? ` — ${data.public.state}${data.public.reason ? `: ${data.public.reason}` : ""}` : ""}`,
    `editor    ${data.editor?.enabled ? `${data.editor.running ? "running" : "starting"} at ${data.editor.url}` : "off"}`,
    `sync      ${data.sync?.enabled ? (data.sync.running ? "running" : "starting") : "off"}`,
    `telegram  ${data.settings.telegram ? "on" : "off"}`,
    `sessions  ${data.counts.projects} projects, ${data.counts.memories} memories`,
  ];
}

function syncLines(data: any, label: string) {
  return [
    `${label.padEnd(9)} ${data.enabled ? (data.running ? "running" : "starting") : "off"}${data.deviceId ? ` · ${data.deviceId.slice(0, 7)}…` : ""}`,
    ...data.folders.map((f: any) => `  ${String(f.id).padEnd(18)} ${f.state ?? ""} ${f.needBytes ? `${f.needBytes} B behind` : ""}`),
  ];
}

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
      await import(process.platform === "darwin" ? "../host/install-daemon.ts" : "../host/install-daemon-linux.ts");
      break;
    case "chat": {
      const data = await post("/chat", { text: positional.join(" ") });
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
      const data = await api("/tasks");
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
    case "reset":
      out(await post("/reset", {}));
      break;
    case "tail":
      await follow(positional[0], args.includes("--raw"));
      break;
    case "events": {
      const data = await api(`/events${positional[0] ? `?session=${positional[0]}` : ""}`);
      out(data, () => data.map((e: any) => `${clock(e.ts)} ${(e.sessionId ?? "").slice(0, 6).padEnd(6)} ${e.kind.padEnd(18)} ${summarize(e)}`).join("\n"));
      break;
    }
    case "memory": {
      const data = await api(`/memory?q=${encodeURIComponent(positional.join(" "))}`);
      out(data, () =>
        data.length
          ? data.map((m: any) => `${m.name.padEnd(28)} ${m.type.padEnd(10)} ${m.description.slice(0, 80)}`).join("\n")
          : "(nothing saved)",
      );
      break;
    }
    case "projects": {
      const data = await api(`/projects${args.includes("--refresh") ? "?refresh=1" : ""}`);
      out(data, () => data.map((p: any) => `${p.slug.padEnd(28)} ${p.summary.slice(0, 80)}`).join("\n"));
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
      console.log(devUsage);
  }
}

try {
  await (dev ? devCommand() : userCommand());
} catch (err) {
  console.error(`error: ${(err as Error).message}`);
  if ((err as Error).message.includes("Unable to connect")) console.error("is the daemon running? `pai dev daemon`");
  process.exit(1);
}
