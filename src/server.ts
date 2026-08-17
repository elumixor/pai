import { config } from "./config.ts";
import { all as allProjects, refresh } from "./catalog.ts";
import { bus, recentEvents, type BuilderEvent } from "./bus.ts";
import { chat } from "./agent.ts";
import { clear, transcript } from "./chat.ts";
import { find, listAll, recentByProject, ensureLive, spawn } from "./sessions.ts";
import { db } from "./db.ts";
import { logger } from "./log.ts";

const log = logger("server");

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json" } });

async function body<T>(req: Request): Promise<T> {
  return (await req.json()) as T;
}

export function startServer() {
  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      try {
        if (path === "/health") return json({ ok: true, pid: process.pid, uptime: process.uptime() });

        if (path === "/projects") {
          if (url.searchParams.get("refresh")) refresh();
          return json(allProjects());
        }

        if (path === "/chat" && req.method === "POST") {
          const { text } = await body<{ text: string }>(req);
          return json(await chat(text));
        }

        if (path === "/chat/history") {
          if (req.method === "DELETE") {
            clear();
            return json({ ok: true });
          }
          return json(transcript(100));
        }

        if (path === "/spawn" && req.method === "POST") {
          const { project, text } = await body<{ project: string; text: string }>(req);
          const session = spawn(project, text.slice(0, 80));
          session.send(text);
          return json(session.toJSON());
        }

        if (path === "/send" && req.method === "POST") {
          const { sessionId, text } = await body<{ sessionId: string; text: string }>(req);
          const session = ensureLive(sessionId);
          if (!session) return json({ error: "no such session" }, 404);
          session.send(text);
          return json(session.toJSON());
        }

        if (path === "/kill" && req.method === "POST") {
          const { sessionId } = await body<{ sessionId: string }>(req);
          const session = find(sessionId);
          if (!session) return json({ error: "no such session" }, 404);
          session.kill();
          return json({ ok: true });
        }

        if (path === "/ps") return json({ ...(await listAll()), recent: recentByProject(undefined, 20) });

        if (path === "/events") {
          const raw = url.searchParams.get("session") ?? undefined;
          const sessionId = raw ? (find(raw)?.id ?? resolveSessionId(raw) ?? raw) : undefined;
          if (!url.searchParams.get("follow")) return json(recentEvents(sessionId, 200));
          return sse(sessionId);
        }

        return json({ error: "not found" }, 404);
      } catch (err) {
        log.error(path, err);
        return json({ error: (err as Error).message }, 500);
      }
    },
  });
  log.info(`http://${config.host}:${server.port}`);
  return server;
}

function resolveSessionId(idOrShort: string): string | undefined {
  const row = db
    .query("SELECT session_id FROM sessions WHERE session_id = ? OR short_id = ? ORDER BY last_activity DESC LIMIT 1")
    .get(idOrShort, idOrShort) as { session_id: string } | undefined;
  return row?.session_id;
}

function sse(sessionId?: string) {
  const enc = new TextEncoder();
  let write: (e: BuilderEvent) => void = () => {};
  let ping: ReturnType<typeof setInterval>;

  const stream = new ReadableStream({
    start(controller) {
      write = (e) => {
        if (sessionId && e.sessionId !== sessionId) return;
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          /* client went away between events */
        }
      };
      for (const e of recentEvents(sessionId, 50)) write(e);
      bus.on("event", write);
      ping = setInterval(() => {
        try {
          controller.enqueue(enc.encode(": ping\n\n"));
        } catch {
          /* same */
        }
      }, 15000);
    },
    cancel() {
      clearInterval(ping);
      bus.off("event", write);
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}
