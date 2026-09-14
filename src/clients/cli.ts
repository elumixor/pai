#!/usr/bin/env bun
export {}; // dynamic imports only, but top-level await needs this file to be a module
const [cmd, ...args] = process.argv.slice(2);

// The foreground daemon is the dev loop: verbose, and no bot fighting the installed one for the token.
// These have to be set before config.ts is evaluated, so config is imported after.
const foreground = args.includes("--foreground") || args.includes("-f");
if (cmd === "daemon" && foreground) {
  process.env.PAI_NO_TELEGRAM ??= "1";
  process.env.PAI_VERBOSE ??= "1";
}
const { config } = await import("../core/config.ts");
const base = `http://${config.host}:${config.port}`;
const jsonOut = args.includes("--json");
const positional = args.filter((a) => !a.startsWith("--"));

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

const usage = `pai

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
  status                       version, address, public URL, editor, sync
  settings [KEY=value …]       read or change the daemon's settings; a change needs a restart
  restart                      restart the daemon
  cost                         what the host costs per month, priced from Hetzner
  memory [query]               what the assistant remembers; a query searches
  sync [device id]             file sync between machines; with an id, pair with that machine
  daemon [--foreground]        start the daemon; --foreground stays attached, verbose, no telegram
  install [--uninstall]        launchd user agent + \`pai\` on PATH
  update [--check] [--force]   pull, reinstall, rebuild, restart the daemon

  --json on any command for raw output`;

try {
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
    // `pai sync` shows this machine's device id; `pai sync <id>` pairs it with the other one.
    case "sync": {
      const peer = positional[0];
      if (peer) {
        await patch("/settings", { PAI_SYNC: "1", PAI_SYNC_PEER: peer });
        await post("/restart", {});
        console.log(`paired with ${peer}; the daemon is restarting to pick it up`);
        break;
      }
      const data = await api("/sync");
      out(data, () =>
        [
          `enabled   ${data.enabled ? "yes" : "no"}${data.running ? " (running)" : ""}`,
          `device    ${data.deviceId || "(not started)"}`,
          `peer      ${data.peer || "(none — run `pai sync <device id>` on both machines)"}`,
          ...data.folders.map((f: any) => `${String(f.id).padEnd(18)} ${f.state ?? ""} ${f.needBytes ? `${f.needBytes} B behind` : ""}`),
        ].join("\n"),
      );
      break;
    }
    case "projects": {
      const data = await api(`/projects${args.includes("--refresh") ? "?refresh=1" : ""}`);
      out(data, () => data.map((p: any) => `${p.slug.padEnd(28)} ${p.summary.slice(0, 80)}`).join("\n"));
      break;
    }
    case "status": {
      const data = await api("/health");
      out(data, () =>
        [
          `version   ${data.version}`,
          `host      ${data.host.hostname} (${data.host.platform}), api ${data.host.api}`,
          `public    ${data.public?.url ?? "(off)"}${data.public?.state && data.public.state !== "up" ? ` — ${data.public.state}${data.public.reason ? `: ${data.public.reason}` : ""}` : ""}`,
          `editor    ${data.editor?.enabled ? `${data.editor.running ? "running" : "starting"} at ${data.editor.url}` : "off"}`,
          `sync      ${data.sync?.enabled ? (data.sync.running ? "running" : "starting") : "off"}`,
          `telegram  ${data.settings.telegram ? "on" : "off"}`,
          `token     ${data.settings.tokenSet ? "set" : "none"}`,
          `google    ${data.settings.google ? `on, allowed: ${data.settings.google.join(", ") || "(nobody — set PAI_GOOGLE_ALLOWED)"}` : "off"}`,
          `sessions  ${data.counts.projects} projects, ${data.counts.memories} memories`,
        ].join("\n"),
      );
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
    default:
      console.log(usage);
  }
} catch (err) {
  console.error(`error: ${(err as Error).message}`);
  if ((err as Error).message.includes("Unable to connect")) console.error("is the daemon running? `pai daemon`");
  process.exit(1);
}
