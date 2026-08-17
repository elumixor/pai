#!/usr/bin/env bun
import { config } from "./config.ts";

const base = `http://${config.host}:${config.port}`;
const [cmd, ...args] = process.argv.slice(2);
const jsonOut = args.includes("--json");
const positional = args.filter((a) => !a.startsWith("--"));

function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function api(path: string, init?: RequestInit) {
  const res = await fetch(base + path, init);
  const text = await res.text();
  try {
    return JSON.parse(text) as any;
  } catch {
    throw new Error(`${res.status} ${text.slice(0, 200)}`);
  }
}

const post = (path: string, data: unknown) =>
  api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });

function out(data: unknown, pretty?: () => string) {
  if (jsonOut || !pretty) console.log(JSON.stringify(data, null, 2));
  else console.log(pretty());
}

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
      else console.log(`${new Date(e.ts).toISOString().slice(11, 19)} ${e.kind} ${summarize(e)}`);
    }
  }
}

function summarize(e: any): string {
  const p = e.payload ?? {};
  if (e.kind === "session.tool") return `${p.name} ${p.summary ?? ""}`;
  if (e.kind === "session.text" || e.kind === "session.turn_end" || e.kind === "session.input")
    return String(p.text ?? "").replace(/\s+/g, " ").slice(0, 160);
  return JSON.stringify(p).slice(0, 160);
}

const usage = `builder cli

  daemon                       run the daemon in the foreground (no telegram)
  chat <text>                  talk to builder — the same path Telegram uses
  history [--clear]            the conversation builder remembers
  projects [--refresh]         list the catalog as the agent sees it
  spawn <project> <text>       start a session in a project, skipping the agent
  send <id> <text>             send a turn to an existing session
  ps                           builder sessions + every other claude session
  tail [id] [--raw]            follow the event stream
  events [id]                  recent events
  kill <id>

  --json on any command for raw output`;

try {
  switch (cmd) {
    case "daemon": {
      process.env.BUILDER_NO_TELEGRAM ??= "1";
      process.env.BUILDER_VERBOSE ??= "1";
      await import("./daemon.ts");
      break;
    }
    case "projects": {
      const data = await api(`/projects${args.includes("--refresh") ? "?refresh=1" : ""}`);
      out(data, () => data.map((p: any) => `${p.slug.padEnd(28)} ${p.summary.slice(0, 80)}`).join("\n"));
      break;
    }
    case "chat": {
      const data = await post("/chat", { text: positional.join(" ") });
      out(data, () => data.text);
      break;
    }
    case "history": {
      if (args.includes("--clear")) {
        out(await api("/chat/history", { method: "DELETE" }), () => "cleared");
        break;
      }
      const data = await api("/chat/history");
      out(data, () => data.map((m: any) => `${m.role.padEnd(9)} ${m.content.replace(/\n/g, " ").slice(0, 140)}`).join("\n"));
      break;
    }
    case "spawn": {
      const [project, ...rest] = positional;
      const data = await post("/spawn", { project, text: rest.join(" ") });
      out(data, () => `${data.project} · ${data.shortId} ${data.state}`);
      break;
    }
    case "send": {
      const [id, ...rest] = positional;
      const data = await post("/send", { sessionId: id, text: rest.join(" ") });
      out(data, () => `${data.project} · ${data.shortId} ${data.state}`);
      break;
    }
    case "ps": {
      const data = await api("/ps");
      out(data, () =>
        [
          "builder sessions:",
          ...(data.owned.length ? data.owned.map((s: any) => `  ${s.shortId}  ${s.project.padEnd(20)} ${s.state}`) : ["  (none)"]),
          "other claude sessions:",
          ...data.foreign.map((f: any) => `  ${String(f.sessionId).slice(0, 6)}  ${f.cwd}  ${f.kind}`),
        ].join("\n"),
      );
      break;
    }
    case "tail":
      await follow(positional[0], args.includes("--raw"));
      break;
    case "events": {
      const data = await api(`/events${positional[0] ? `?session=${positional[0]}` : ""}`);
      out(data, () => data.map((e: any) => `${new Date(e.ts).toISOString().slice(11, 19)} ${e.kind} ${summarize(e)}`).join("\n"));
      break;
    }
    case "kill":
      out(await post("/kill", { sessionId: positional[0] }));
      break;
    default:
      console.log(usage);
  }
} catch (err) {
  console.error(`error: ${(err as Error).message}`);
  if ((err as Error).message.includes("Unable to connect")) console.error("is the daemon running? `bun run src/cli.ts daemon`");
  process.exit(1);
}
