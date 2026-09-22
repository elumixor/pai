import { config } from "../core/config.ts";
import { all as allProjects, clone, CloneError, createContext, refresh } from "../domain/catalog.ts";
import * as automations from "../domain/automations.ts";
import { context } from "../domain/context.ts";
import { byName as moduleByName, describeModules } from "../modules/index.ts";
import * as external from "../modules/external.ts";
import { poll as linkedinPoll } from "../modules/linkedin.ts";
import { handleConnect as gmailConnect, listAccounts as gmailAccounts, removeAccount as gmailRemove } from "../modules/gmail.ts";
import { installCredentials, needsLogin, usage } from "../domain/usage.ts";
import { diagnostics } from "../domain/diagnostics.ts";
import { recentEvents, waitFor } from "../core/bus.ts";
import * as sessions from "../domain/sessions.ts";
import * as terminals from "../domain/terminals.ts";
import { status as updateStatus, update } from "../host/update.ts";
import { logger } from "../core/log.ts";
import { events } from "./events.ts";
import { messagePage } from "./message.ts";
import { status } from "./status.ts";
import * as files from "../domain/files.ts";
import * as settings from "../domain/settings.ts";
import { sessionsIn, transcript, transcriptPath } from "../domain/transcript.ts";
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
    // One consent per mailbox; the code comes back through /auth/google/callback.
    if (path === "/gmail/connect") return gmailConnect(req, url);
    if (path === "/gmail/accounts" && req.method === "GET") return json(gmailAccounts().map(({ label, email }) => ({ label, email })));
    if (path === "/gmail/accounts" && req.method === "DELETE") {
      const label = url.searchParams.get("label") ?? "";
      return gmailRemove(label) ? json({ removed: label }) : json({ error: `no account labeled ${label}` }, 404);
    }

    if (path === "/health") return json(await status());

    // Hands the main conversation to a terminal: its process goes down so an interactive
    // `claude --resume` owns the transcript alone; the next message here revives it, with
    // whatever was said in the terminal in its history.
    if (path === "/attach" && req.method === "POST") {
      const { id, force } = await body<{ id?: string; force?: boolean }>(req);
      const s = !id || id === "main" ? sessions.main() : resolveLive(id);
      if (!s) return json({ error: "no such session" }, 404);
      if (s.state === "busy" && !force) return json({ error: `${s.shortId} is mid-turn; wait, or pass --force` }, 409);
      const fresh = !transcriptPath(s.id, s.cwd);
      s.kill();
      return json({ id: s.id, cwd: s.cwd, fresh, title: s.title });
    }

    // A session's model and effort from now on; its process restarts on the next message.
    if (path === "/reconfigure" && req.method === "POST") {
      const { id, model, effort } = await body<{ id: string; model?: string | null; effort?: "low" | "medium" | "high" | "xhigh" | "max" | null }>(req);
      try {
        return json(sessions.reconfigure(id, { model, effort }));
      } catch (err) {
        return json({ error: (err as Error).message }, 409);
      }
    }

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

    if (path === "/settings" && req.method === "PATCH") {
      const changes = await body<Record<string, unknown>>(req);
      return json(await settings.write(changes));
    }

    if (path === "/settings")
      return json({ editable: settings.EDITABLE, effective: settings.effective(), overrides: await settings.current() });

    if (path === "/docs") return json(files.documents());

    // The service manager brings the daemon back, which is what "restart" means here. A signal,
    // not exit(): the daemon's own shutdown notes which turns it cut off, and the next start
    // resumes them — a session that restarts the daemon from a tool call is one of them.
    if (path === "/restart" && req.method === "POST") {
      setTimeout(() => process.kill(process.pid, "SIGTERM"), 300);
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
    if (path === "/usage") return json({ ...(await usage()), needsLogin: needsLogin() });

    // A laptop's Claude Code login for this machine: the limits and `claude` here use it from now on.
    if (path === "/usage/credentials" && req.method === "POST") {
      try {
        await installCredentials(await req.text());
        return json(await usage());
      } catch (err) {
        return json({ error: (err as Error).message }, 400);
      }
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
      const { title, text, project, model, effort } = await body<{ title: string; text: string; project?: string; model?: string | null; effort?: "low" | "medium" | "high" | "xhigh" | "max" | null }>(req);
      const s = sessions.spawnTask({ title, project, model, effort });
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

    // The slash commands a session's process accepts; a session that is not live falls back to the main one's.
    if (path === "/commands") {
      const raw = url.searchParams.get("session") ?? "main";
      const s = (raw === "main" ? sessions.main() : sessions.find(raw)) ?? sessions.main();
      return json(s.commands.length ? s.commands : sessions.main().commands);
    }

    // What each kind of session is given, for the dashboard.
    if (path === "/context") return json(context());

    // A module's own http, under its name; anything else under /m/ is a message page (below).
    if (path.startsWith("/m/")) {
      const answered = await external.route(req, url);
      if (answered) return answered;
    }

    // One list for the dashboard: the built-in pieces and the modules from their own repositories.
    if (path === "/modules")
      return json([
        ...describeModules(),
        ...(await external.describe()).map((m) => ({
          ...m,
          title: m.title ?? m.name,
          description: m.description ?? "",
          status: { health: m.health, source: m.source, linked: m.linked, started: m.started, cli: m.cli, ui: m.ui },
          live: true,
          external: true,
        })),
      ]);

    const modulePath = /^\/modules\/([a-z0-9-]+)(?:\/(poll|install|update|remove))?$/.exec(path);
    if (modulePath?.[1] && external.get(modulePath[1])) {
      const name = modulePath[1];
      const l = external.get(name)!;
      if (modulePath[2] === "install" && req.method === "POST") return json({ dir: await external.install(name, l.source), restartRequired: true });
      if (modulePath[2] === "update" && req.method === "POST") return json({ ...(await external.update(name)), restartRequired: true });
      if (modulePath[2] === "remove" && req.method === "POST") return json({ removed: external.remove(name), restartRequired: true });
      return json((await external.describe()).find((m) => m.name === name));
    }
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
