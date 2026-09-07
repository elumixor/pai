import { config } from "./config.ts";
import { all as allProjects, refresh } from "./catalog.ts";
import { bus, recentEvents, waitFor, type PaiEvent } from "./bus.ts";
import * as sessions from "./sessions.ts";
import { status as updateStatus, update } from "./update.ts";
import { logger } from "./log.ts";

const log = logger("server");

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json" } });

async function body<T>(req: Request): Promise<T> {
  return (await req.json()) as T;
}

const TURN_TIMEOUT = 15 * 60 * 1000;

export function startServer() {
  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      try {
        if (path === "/health")
          return json({ ok: true, pid: process.pid, uptime: process.uptime(), dashboardUrl: config.dashboard.url || undefined, dashboardKey: config.dashboard.secret || undefined });

        // The response goes out before the process exits, so the CLI sees the result of its own update.
        if (path === "/update" && req.method === "POST") {
          const { force } = await body<{ force?: boolean }>(req);
          return json(await update(force));
        }

        if (path === "/update") return json(await updateStatus());

        if (path === "/projects") {
          if (url.searchParams.get("refresh")) refresh();
          return json(allProjects());
        }

        // A turn in the main conversation, identical to a Telegram message in the root chat.
        if (path === "/chat" && req.method === "POST") {
          const { text } = await body<{ text: string }>(req);
          const m = sessions.main();
          const done = waitFor("session.turn_end", m.id, TURN_TIMEOUT);
          m.send(text);
          const e = await done;
          return json({ session: m.shortId, ...e.payload });
        }

        if (path === "/task" && req.method === "POST") {
          const { title, text, project } = await body<{ title: string; text: string; project?: string }>(req);
          const s = sessions.spawnTask({ title, project });
          if (text) s.send(text);
          return json(s.summary());
        }

        if (path === "/send" && req.method === "POST") {
          const { id, text, wait } = await body<{ id: string; text: string; wait?: boolean }>(req);
          const s = resolveLive(id);
          if (!s) return json({ error: "no such session" }, 404);
          const done = wait ? waitFor("session.turn_end", s.id, TURN_TIMEOUT) : undefined;
          s.send(text);
          if (!done) return json(s.summary());
          return json({ session: s.shortId, ...(await done).payload });
        }

        if (path === "/answer" && req.method === "POST") {
          const { id, text } = await body<{ id: string; text: string }>(req);
          const s = id === "main" ? sessions.main() : sessions.find(id);
          if (!s) return json({ error: "no such session" }, 404);
          return json({ answered: s.answer(text) });
        }

        if (path === "/stop" && req.method === "POST") {
          const { id, kill } = await body<{ id: string; kill?: boolean }>(req);
          const s = id === "main" ? sessions.main() : sessions.find(id);
          if (!s) return json({ error: "no such session" }, 404);
          if (kill) s.kill();
          else await s.interrupt();
          return json({ ok: true });
        }

        if (path === "/reset" && req.method === "POST") {
          sessions.resetMain();
          return json({ ok: true });
        }

        if (path === "/tasks") return json({ live: sessions.list(), recent: sessions.recent(30) });

        if (path === "/events") {
          const raw = url.searchParams.get("session") ?? undefined;
          const sessionId = raw ? (sessions.find(raw)?.id ?? sessions.resolveId(raw) ?? raw) : undefined;
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

function resolveLive(id: string) {
  if (id === "main") return sessions.main();
  const full = sessions.find(id)?.id ?? sessions.resolveId(id);
  return full ? sessions.ensureLive(full) : undefined;
}

function sse(sessionId?: string) {
  const enc = new TextEncoder();
  let write: (e: PaiEvent) => void = () => {};
  let ping: ReturnType<typeof setInterval>;

  const stream = new ReadableStream({
    start(controller) {
      write = (e) => {
        if (sessionId && e.sessionId !== sessionId) return;
        if (e.kind === "session.delta") return;
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
