import { config } from "../core/config.ts";
import { all as allProjects, clone, CloneError, createContext, refresh } from "../domain/catalog.ts";
import * as automations from "../domain/automations.ts";
import { context } from "../domain/context.ts";
import { byName as moduleByName, describeModules } from "../modules/index.ts";
import { poll as linkedinPoll } from "../modules/linkedin.ts";
import { usage } from "../domain/usage.ts";
import { diagnostics } from "../domain/diagnostics.ts";
import { recentEvents, waitFor } from "../core/bus.ts";
import * as sessions from "../domain/sessions.ts";
import * as terminals from "../domain/terminals.ts";
import * as memory from "../domain/memory.ts";
import { status as updateStatus, update } from "../host/update.ts";
import { logger } from "../core/log.ts";
import { events } from "./events.ts";
import { messagePage } from "./message.ts";
import { status } from "./status.ts";
import * as files from "../domain/files.ts";
import * as settings from "../domain/settings.ts";
import { sessionsIn, transcript } from "../domain/transcript.ts";
import { syncProgress, syncStatus } from "../domain/sync.ts";
import { cost as hostingCost } from "../domain/hetzner.ts";

const log = logger("api");

const TURN_TIMEOUT = 15 * 60 * 1000;

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json" } });

async function body<T>(req: Request): Promise<T> {
  return (await req.json()) as T;
}

function resolveLive(id: string) {
  if (id === "main") return sessions.main();
  const full = sessions.find(id)?.id ?? sessions.resolveId(id);
  return full ? sessions.ensureLive(full) : undefined;
}

/** Every route is here so the transport (`server.ts`) knows nothing about the domain. */
export async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  try {
    if (path === "/health") return json(await status());

    if (path === "/files") return json(files.list(url.searchParams.get("path") ?? config.devRoot));

    if (path === "/file" && req.method === "PUT") {
      const { path: target, text } = await body<{ path: string; text: string }>(req);
      return json(files.write(target, text));
    }

    if (path === "/file") return json(await files.read(url.searchParams.get("path") ?? ""));

    if (path === "/files/index") return json(files.index(url.searchParams.get("path") ?? config.devRoot));

    // Type errors for a file, from tsc on the project around it.
    if (path === "/diagnostics") return json(await diagnostics(url.searchParams.get("path") ?? "", url.searchParams.get("fresh") === "1"));

    if (path === "/roots") return json(files.roots());

    // A thread's conversation as it is on disk, which is what `claude --resume` shows.
    if (path === "/transcript") {
      const raw = url.searchParams.get("session") ?? "main";
      const session = raw === "main" ? sessions.main() : sessions.find(raw);
      const id = session?.id ?? sessions.resolveId(raw) ?? raw;
      const limit = Number(url.searchParams.get("limit") ?? 200);
      return json(await transcript(id, session?.cwd ?? url.searchParams.get("cwd") ?? undefined, limit));
    }

    // Conversations held in a directory, terminal ones included; `/send` with a cwd adopts one.
    if (path === "/threads") {
      const cwd = url.searchParams.get("cwd");
      if (!cwd) return json({ error: "cwd required" }, 400);
      return json(await sessionsIn(cwd, Number(url.searchParams.get("limit") ?? 30)));
    }

    // What the machines are agreeing on: the device id to pair with, and what is still in flight.
    if (path === "/sync") return json({ ...syncStatus(), folders: await syncProgress() });

    if (path === "/settings" && req.method === "PATCH") {
      const changes = await body<Record<string, unknown>>(req);
      return json(await settings.write(changes));
    }

    if (path === "/settings")
      return json({ editable: settings.EDITABLE, effective: settings.effective(), overrides: await settings.current() });

    if (path === "/docs") return json(files.documents());

    // The service manager brings the daemon back, which is what "restart" means here.
    if (path === "/restart" && req.method === "POST") {
      setTimeout(() => process.exit(0), 300);
      return json({ restarting: true });
    }

    // The response goes out before the process exits, so the CLI sees the result of its own update.
    if (path === "/update" && req.method === "POST") {
      const { force } = await body<{ force?: boolean }>(req);
      return json(await update(force));
    }

    if (path === "/update") return json(await updateStatus());

    // A project is added by cloning a repository under devRoot, or as a context: a directory
    // in the workspace with instructions and memory of its own.
    if (path === "/projects" && req.method === "POST") {
      const { url: source, name, about } = await body<{ url?: string; name?: string; about?: string }>(req);
      try {
        return json(source ? clone(source, name) : createContext(name ?? "", about), 201);
      } catch (err) {
        if (err instanceof CloneError) return json({ error: err.message }, 400);
        throw err;
      }
    }

    if (path === "/projects") {
      if (url.searchParams.get("refresh")) refresh();
      return json(allProjects());
    }

    // The subscription's limits and what the sessions have cost, for the clients' status line.
    if (path === "/usage") return json(await usage());

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
      const { id, text, wait, cwd, title, images } = await body<{ id: string; text: string; wait?: boolean; cwd?: string; title?: string; images?: { media_type: string; data: string }[] }>(req);
      const s = resolveLive(id) ?? (cwd ? sessions.adopt(id, cwd, title ?? "") : undefined);
      if (!s) return json({ error: "no such session" }, 404);
      const done = wait ? waitFor("session.turn_end", s.id, TURN_TIMEOUT) : undefined;
      s.send(text, { images });
      if (!done) return json(s.summary());
      return json({ session: s.shortId, ...(await done).payload });
    }

    if (path === "/answer" && req.method === "POST") {
      const { id, text } = await body<{ id: string; text: string }>(req);
      const s = resolveLive(id);
      if (!s) return json({ error: "no such session" }, 404);
      if (!s.pending) return json({ answered: false, error: "no question pending" });
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

    if (path === "/memory" && req.method === "POST") {
      const input = await body<memory.Remember>(req);
      try {
        return json(memory.remember(input), 201);
      } catch (err) {
        return json({ error: (err as Error).message }, 400);
      }
    }

    const memoryPath = /^\/memory\/([a-z0-9-]+)$/.exec(path);
    if (memoryPath?.[1] && req.method === "DELETE") return json({ forgotten: memory.forget(memoryPath[1]) });

    if (path === "/memory") return json(memory.recall(url.searchParams.get("q") ?? "", url.searchParams.get("project") ?? undefined));

    // What each kind of session is given, for the dashboard.
    if (path === "/context") return json(context());

    if (path === "/modules") return json(describeModules());

    const modulePath = /^\/modules\/([a-z-]+)(?:\/(poll))?$/.exec(path);
    if (modulePath?.[1]) {
      const module = moduleByName(modulePath[1]);
      if (!module) return json({ error: "no such module" }, 404);
      if (modulePath[2] === "poll" && req.method === "POST") return json(module.name === "linkedin" ? await linkedinPoll() : { error: "nothing to poll" });
      if (req.method === "PATCH") {
        const changes = await body<Record<string, unknown>>(req);
        const allowed = new Set(module.settings?.map((s) => s.key) ?? []);
        for (const key of Object.keys(changes)) if (!allowed.has(key)) return json({ error: `${key} is not a setting of ${module.name}` }, 400);
        return json(await settings.write(changes));
      }
      return json(describeModules().find((m) => m.name === module.name));
    }

    if (path === "/automations" && req.method === "POST") return json(automations.create(await body<automations.AutomationInput>(req)), 201);
    if (path === "/automations") return json(automations.all());
    const automationPath = /^\/automations\/(\d+)$/.exec(path);
    if (automationPath?.[1]) {
      const id = Number(automationPath[1]);
      if (req.method === "DELETE") return json({ removed: automations.remove(id) });
      if (req.method === "PATCH") {
        const updated = automations.update(id, await body<Partial<automations.AutomationInput>>(req));
        return updated ? json(updated) : json({ error: "no such automation" }, 404);
      }
    }

    if (path === "/cost")
      return json(await hostingCost().catch((err: Error) => ({ error: err.message })));

    if (path === "/tasks") return json({ live: sessions.list(), recent: sessions.recent(30) });

    if (path === "/terminals" && req.method === "POST") {
      const opts = await body<terminals.OpenOptions>(req);
      return json(terminals.open(opts).summary());
    }

    if (path === "/terminals") return json(terminals.list());

    const terminalPath = /^\/terminals\/([\w-]+)$/.exec(path);
    if (terminalPath?.[1]) {
      const id = terminalPath[1];
      const terminal = terminals.get(id);
      if (!terminal) return json({ error: "no such terminal" }, 404);
      if (req.method === "DELETE") return json({ closed: terminals.close(id) });
      if (req.method === "POST") {
        const { cols, rows } = await body<{ cols: number; rows: number }>(req);
        terminal.resize(cols, rows);
        return json(terminal.summary());
      }
      return json(terminal.summary());
    }

    const message = /^\/m\/([A-Za-z0-9_-]+)$/.exec(path);
    if (message?.[1]) return messagePage(message[1]);

    if (path === "/events") {
      const raw = url.searchParams.get("session") ?? undefined;
      const sessionId = raw ? (sessions.find(raw)?.id ?? sessions.resolveId(raw) ?? raw) : undefined;
      if (!url.searchParams.get("follow")) return json(recentEvents(sessionId, Number(url.searchParams.get("limit") ?? 200)));
      return events(sessionId, { deltas: url.searchParams.get("deltas") === "1", replay: url.searchParams.get("replay") !== "0" });
    }

    return json({ error: "not found" }, 404);
  } catch (err) {
    log.error(path, err);
    return json({ error: (err as Error).message }, 500);
  }
}
