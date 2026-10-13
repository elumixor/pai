import { config } from "../core/config.ts";
import { all as allProjects, clone, CloneError, createContext, refresh } from "../domain/catalog.ts";
import * as automations from "../domain/automations.ts";
import { context, save as saveContext } from "../domain/context.ts";
import { byName as moduleByName, describeModules } from "../modules/index.ts";
import * as external from "../modules/external.ts";
import { handleConnect as gmailConnect, listAccounts as gmailAccounts, removeAccount as gmailRemove } from "../modules/gmail.ts";
import { installCredentials, needsLogin, usage } from "../domain/usage.ts";
import { diagnostics } from "../domain/diagnostics.ts";
import { recentEvents, waitFor } from "../core/bus.ts";
import * as sessions from "../domain/sessions.ts";
import * as mirror from "../domain/mirror.ts";
import * as channels from "../domain/channels.ts";
import * as terminals from "../domain/terminals.ts";
import { status as updateStatus, update } from "../host/update.ts";
import { logger } from "../core/log.ts";
import { events } from "./events.ts";
import { messagePage } from "./message.ts";
import { status } from "./status.ts";
import * as files from "../domain/files.ts";
import * as settings from "../domain/settings.ts";
import { allThreads, ensureTranscriptAt, sessionsIn, transcript, transcriptPath } from "../domain/transcript.ts";
import { cost as hostingCost } from "../domain/hetzner.ts";
import * as agents from "../domain/agents.ts";
import * as asks from "../domain/asks.ts";
import * as main from "../domain/main.ts";
import * as messages from "../domain/messages.ts";
import * as summaries from "../domain/summaries.ts";
import * as recall from "../domain/recall.ts";
import * as requests from "../domain/requests.ts";
import * as tasks from "../domain/tasks.ts";
import * as sync from "../domain/sync.ts";

const log = logger("api");

const TURN_TIMEOUT = 15 * 60 * 1000;

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json" } });

async function body<T>(req: Request): Promise<T> {
  return (await req.json()) as T;
}

function resolveLive(id: string) {
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

    // A terminal's `claude` listening for what is typed for its conversation elsewhere (`pai channel`).
    if (path === "/channel" && req.method === "GET") {
      const session = url.searchParams.get("session");
      return session ? channels.stream(session) : json({ error: "session required" }, 400);
    }

    // Hands the main conversation to a terminal: its process goes down so an interactive
    // `claude --resume` owns the transcript alone; the next message here revives it, with
    // whatever was said in the terminal in its history.
    if (path === "/attach" && req.method === "POST") {
      const { id, cwd, force } = await body<{ id?: string; cwd?: string; force?: boolean }>(req);
      const s = id ? (resolveLive(id) ?? (cwd ? sessions.adopt(id, cwd, "") : undefined)) : undefined;
      if (!s) return json({ error: "no such session" }, 404);
      if (s.state === "busy" && !force) return json({ error: `${s.shortId} is mid-turn; wait, or pass --force` }, 409);
      const fresh = !ensureTranscriptAt(s.id, s.cwd);
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
      const raw = url.searchParams.get("session") ?? "";
      const session = sessions.find(raw);
      const id = session?.id ?? sessions.resolveId(raw) ?? raw;
      const limit = Number(url.searchParams.get("limit") ?? 200);
      return json(await transcript(id, session?.cwd ?? url.searchParams.get("cwd") ?? undefined, limit));
    }

    // Every conversation in every project, the daemon's and terminal ones, synced ones included.
    if (path === "/threads/all") return json(await allThreads(Number(url.searchParams.get("per") ?? 15)));

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

    // Each Mac's file sync against this box, as its menu bar app reports it.
    if (path === "/sync" && req.method === "POST") {
      try {
        sync.record(await body<Record<string, unknown>>(req));
        return json({ ok: true });
      } catch (err) {
        return json({ error: (err as Error).message }, 400);
      }
    }
    if (path === "/sync") return json(sync.list());

    // A laptop's Claude Code login for this machine: the limits and `claude` here use it from now on.
    if (path === "/usage/credentials" && req.method === "POST") {
      try {
        await installCredentials(await req.text());
        return json(await usage());
      } catch (err) {
        return json({ error: (err as Error).message }, 400);
      }
    }

    // A turn in a conversation: a new one, or `id` for an existing one. The same path as a Telegram message.
    if (path === "/chat" && req.method === "POST") {
      const { text, id, title } = await body<{ text: string; id?: string; title?: string }>(req);
      const m = id ? resolveLive(id) : sessions.spawnTask({ title: title ?? "", origin: "cli" });
      if (!m) return json({ error: "no such session" }, 404);
      const done = waitFor("session.turn_end", m.id, TURN_TIMEOUT);
      m.send(text);
      const e = await done;
      return json({ session: m.shortId, ...e.payload });
    }

    if (path === "/task" && req.method === "POST") {
      const { title, text, project, model, effort, origin, images } = await body<{ title: string; text: string; project?: string; model?: string | null; effort?: "low" | "medium" | "high" | "xhigh" | "max" | null; origin?: "general" | "cli"; images?: { media_type: string; data: string }[] }>(req);
      const s = sessions.spawnTask({ title: title ?? "", project, model, effort, origin: origin === "general" ? "general" : project ? "builder" : "cli" });
      if (text || images?.length) s.send(text ?? "", { images });
      return json(s.summary());
    }

    if (path === "/send" && req.method === "POST") {
      const { id, text, wait, cwd, title, images } = await body<{ id: string; text: string; wait?: boolean; cwd?: string; title?: string; images?: { media_type: string; data: string }[] }>(req);
      // A conversation a terminal holds goes into that terminal while its channel is connected; the mirror resumes it here otherwise.
      const held = !sessions.find(id) ? mirror.find(id) : undefined;
      if (held && !wait) {
        held.send(text, { images });
        return json(held.summary());
      }
      const s = resolveLive(id) ?? (cwd ? sessions.adopt(id, cwd, title ?? "") : undefined);
      if (!s) return json({ error: "no such session" }, 404);
      const done = wait ? waitFor("session.turn_end", s.id, TURN_TIMEOUT) : undefined;
      s.send(text, { images });
      if (!done) return json(s.summary());
      return json({ session: s.shortId, ...(await done).payload });
    }

    // A conversation held on disk (this box's or one synced from another machine) becomes a live session
    // without a turn: a client opens it, its channel gets a place for it.
    if (path === "/adopt" && req.method === "POST") {
      const { id, cwd, title } = await body<{ id: string; cwd: string; title?: string }>(req);
      if (!cwd) return json({ error: "cwd required" }, 400);
      return json(sessions.adopt(id, cwd, title ?? "").summary());
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
      const s = sessions.find(id);
      if (!s) return json({ error: "no such session" }, 404);
      if (kill) s.kill();
      else await s.interrupt();
      return json({ ok: true });
    }

    // The slash commands a session's process accepts; a session that is not live falls back to any live one's.
    if (path === "/commands") {
      const raw = url.searchParams.get("session") ?? "";
      const s = sessions.find(raw);
      const any = [...sessions.list()].map((x) => sessions.find(x.sessionId)).find((x) => x && x.commands.length);
      return json(s?.commands.length ? s.commands : (any?.commands ?? []));
    }

    // What each kind of session is given, for the dashboard.
    if (path === "/context" && req.method === "PUT") {
      const { name, text } = await body<{ name: string; text: string }>(req);
      return json(saveContext(name, text));
    }
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
      if (req.method === "PATCH") {
        const changes = await body<Record<string, unknown>>(req);
        const allowed = new Set(module.settings?.map((s) => s.key) ?? []);
        for (const key of Object.keys(changes)) if (!allowed.has(key)) return json({ error: `${key} is not a setting of ${module.name}` }, 400);
        return json(await settings.write(changes));
      }
      return json(describeModules().find((m) => m.name === module.name));
    }

    // Routines (the automations table): an event or a schedule, a check, an action.
    if ((path === "/automations" || path === "/routines") && req.method === "POST") {
      try {
        return json(automations.create(await body<automations.AutomationInput>(req)), 201);
      } catch (err) {
        return json({ error: (err as Error).message }, 400);
      }
    }
    if (path === "/automations" || path === "/routines") return json(automations.all());
    const automationPath = /^\/(?:automations|routines)\/(\d+)$/.exec(path);
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

    if (path === "/sessions") return json({ live: sessions.list(), recent: sessions.recent(30) });

    // The task list (`items`); `live` and `recent` are the sessions, as clients built before the list read them.
    if (path === "/tasks" && req.method === "POST") {
      try {
        return json(tasks.add({ ...(await body<tasks.TaskInput>(req)), createdBy: "user" }), 201);
      } catch (err) {
        return json({ error: (err as Error).message }, 400);
      }
    }
    if (path === "/tasks") {
      const status = url.searchParams.get("status") as tasks.TaskStatus | null;
      const items = tasks.list({ owner: url.searchParams.get("owner") ?? undefined, status: status ?? undefined, open: url.searchParams.get("all") ? false : undefined });
      return json({ items, live: sessions.list(), recent: sessions.recent(30) });
    }
    const taskPath = /^\/tasks\/(\d+)$/.exec(path);
    if (taskPath?.[1]) {
      const id = Number(taskPath[1]);
      if (req.method === "PATCH") {
        try {
          return json(tasks.update(id, await body<tasks.TaskChanges>(req)));
        } catch (err) {
          return json({ error: (err as Error).message }, 400);
        }
      }
      const t = tasks.get(id);
      return t ? json({ ...t, children: tasks.list({ parentId: id, open: false }) }) : json({ error: "no such task" }, 404);
    }

    // pai and its staff: the tree, one agent's chat, creating, writing to, closing.
    if (path === "/agents" && req.method === "POST") {
      try {
        return json(agents.create(await body<agents.CreateInput>(req)), 201);
      } catch (err) {
        return json({ error: (err as Error).message }, 400);
      }
    }
    if (path === "/agents") return json(agents.tree(tasks.openCounts()));
    const agentPath = /^\/agents\/([a-z0-9-]+)(?:\/(message|close|stop|instructions))?$/.exec(path);
    if (agentPath?.[1]) {
      const slug = agentPath[1];
      const a = agents.get(slug);
      if (!a) return json({ error: "no such agent" }, 404);
      try {
        if (agentPath[2] === "message" && req.method === "POST") {
          const { text, taskId } = await body<{ text: string; taskId?: number }>(req);
          if (!text?.trim()) return json({ error: "text required" }, 400);
          if (slug === agents.PAI) return json({ session: main.send(text).shortId });
          return json(agents.fromUser(slug, text, taskId));
        }
        // Stopping pai is stopping its one session; an agent stops with everything below it.
        if (agentPath[2] === "stop" && req.method === "POST") {
          if (slug === agents.PAI) {
            await main.session().interrupt();
            return json({ stopped: [agents.PAI] });
          }
          return json({ stopped: await agents.stop(slug) });
        }
        if (agentPath[2] === "instructions") return json(agents.instructionsOf(a));
        if (agentPath[2] === "close" && req.method === "POST") return json(agents.close(slug, (await body<{ summary?: string }>(req).catch(() => ({}) as { summary?: string })).summary ?? ""));
        if (req.method === "PATCH") return json(agents.configure(slug, await body<Parameters<typeof agents.configure>[1]>(req)));
      } catch (err) {
        return json({ error: (err as Error).message }, 400);
      }
      return json({ ...a, breadcrumb: agents.breadcrumb(slug), children: agents.list({ parent: slug }), tasks: tasks.list({ owner: slug, open: false }) });
    }

    // The gist of one message, written on first request and kept.
    const headlinePath = /^\/messages\/(\d+)\/headline$/.exec(path);
    if (headlinePath?.[1]) return json({ headline: (await summaries.headline(Number(headlinePath[1]))) ?? null, enabled: summaries.enabled() });
    const tldrPath = /^\/messages\/(\d+)\/tldr$/.exec(path);
    if (tldrPath?.[1]) return json({ tldr: (await summaries.tldr(Number(tldrPath[1]))) ?? null, enabled: summaries.enabled() });

    // The message log: one agent's chat (`agent`), paged back with `before`, caught up with `after`.
    if (path === "/messages") {
      const num = (k: string) => (url.searchParams.get(k) ? Number(url.searchParams.get(k)) : undefined);
      return json(messages.list({ agent: url.searchParams.get("agent") ?? undefined, task: num("task"), before: num("before"), after: num("after"), limit: num("limit") }));
    }

    // A message to pai, the one chat; `wait` holds the response until pai has answered.
    if (path === "/pai" && req.method === "POST") {
      const { text, wait } = await body<{ text: string; wait?: boolean }>(req);
      if (!text?.trim()) return json({ error: "text required" }, 400);
      const s = main.session();
      const done = wait ? waitFor("session.turn_end", s.id, TURN_TIMEOUT) : undefined;
      main.send(text);
      return json(done ? { session: s.shortId, ...(await done).payload } : s.summary());
    }
    if (path === "/pai/rotate" && req.method === "POST") {
      void main.rotate("asked");
      return json({ rotating: true });
    }
    if (path === "/pai") return json({ session: main.session().summary(), thread: main.thread(), lastRotation: main.lastRotation() });

    // Everything that waits on the user, newest first, in one shape: the agents' asks and the questions sessions
    // have open (pai's AskUserQuestion). A phone answers either with one tap: `asks/<id>/answer` or `/answer`.
    if (path === "/needs") {
      // A need sits on its area: the agent that asked, or for pai's own asks the owner of the task it is about.
      const area = (slug: string | undefined) => (slug && slug !== agents.PAI ? slug : null);
      const open = asks.open();
      // An ask held for quiet hours has no row in the chat yet, so it is not a need yet either.
      const fromAsks = open.filter((a) => a.delivered).map((a) => ({
        kind: "ask" as const,
        id: `ask:${a.id}`,
        askId: a.id,
        taskId: a.taskId ?? undefined,
        agent: area(a.agent === agents.PAI && a.taskId ? tasks.get(a.taskId)?.owner : a.agent),
        from: agents.get(a.agent)?.name ?? a.agent,
        question: a.question,
        options: a.options,
        freeText: a.freeText,
        priority: a.priority,
        // A card with a link in its text gets a button that opens it, instead of asking the user to copy it out.
        link: tasks.firstUrl(a.question, a.context),
        createdAt: a.createdAt,
      }));
      const fromSessions = sessions.list().flatMap((summary) => {
        const s = sessions.find(summary.sessionId);
        const index = s?.nextUnanswered();
        const q = index === undefined ? undefined : s!.pending!.questions[index];
        if (!s || !q) return [];
        const owner = summary.agent ? agents.get(summary.agent) : undefined;
        return [{
          kind: "question" as const,
          id: `q:${s.id}:${s.pending!.id}:${index}`,
          session: s.id,
          agent: owner?.slug ?? null,
          from: owner?.name ?? summary.title,
          question: q.question,
          options: q.options.map((o) => o.label),
          freeText: true,
          priority: "normal",
          link: tasks.firstUrl(q.question),
          createdAt: summary.lastActivity,
        }];
      });
      // A task waiting on the user is a decision too: done, dropped, or a word to whoever owns it.
      // A task with an open ask on it is that ask's card already.
      const asked = new Set(open.map((a) => a.taskId));
      const fromTasks = tasks.list({ status: "waiting_user" }).filter((t) => !asked.has(t.id)).map((t) => ({
        kind: "task" as const,
        id: `task:${t.id}`,
        taskId: t.id,
        agent: area(t.owner),
        from: agents.get(t.owner)?.name ?? t.owner,
        question: t.nextAction ? `${t.title}\n${t.nextAction}` : t.title,
        options: ["Done", "Drop"],
        freeText: true,
        priority: "normal",
        link: tasks.firstUrl(t.nextAction, t.source, t.notes),
        createdAt: t.updatedAt,
      }));
      return json([...fromSessions, ...fromAsks, ...fromTasks].sort((a, b) => b.createdAt - a.createdAt));
    }

    // One answer for any of them, by the id `/needs` gave it — what a notification's button sends.
    if (path === "/needs/answer" && req.method === "POST") {
      const { id, text } = await body<{ id: string; text: string }>(req);
      if (!id || !text?.trim()) return json({ error: "id and text required" }, 400);
      try {
        const [kind, ref] = [id.slice(0, id.indexOf(":")), id.slice(id.indexOf(":") + 1)];
        if (kind === "ask") return json({ answered: true, ask: asks.answer(Number(ref), text) });
        if (kind === "q") {
          const s = resolveLive(ref.split(":")[0]!);
          if (!s?.pending) return json({ answered: false, error: "no question pending" });
          return json({ answered: s.answer(text) });
        }
        if (kind === "task") {
          const t = tasks.get(Number(ref));
          if (!t) return json({ error: "no such task" }, 404);
          const choice = text.trim().toLowerCase();
          if (choice === "done" || choice === "drop") {
            const updated = tasks.update(t.id, { status: choice === "done" ? "done" : "dropped" });
            const note = `[the user marked task #${t.id} "${t.title}" ${choice === "done" ? "done" : "dropped"}]`;
            if (t.owner === agents.PAI) main.note(note);
            else agents.noteTo(t.owner, note);
            return json({ answered: true, task: updated });
          }
          const said = `About task #${t.id} "${t.title}": ${text}`;
          if (t.owner === agents.PAI) main.send(said);
          else agents.fromUser(t.owner, said);
          return json({ answered: true });
        }
        return json({ error: `unknown need ${id}` }, 400);
      } catch (err) {
        return json({ error: (err as Error).message }, 400);
      }
    }

    // What the agents are waiting on the user for, and the answers.
    if (path === "/asks") return json(url.searchParams.get("all") ? asks.recentAsks() : asks.open());
    const askPath = /^\/asks\/(\d+)\/(answer|drop)$/.exec(path);
    if (askPath?.[1] && req.method === "POST") {
      try {
        if (askPath[2] === "drop") return json({ dropped: asks.drop(Number(askPath[1])) });
        const { text } = await body<{ text: string }>(req);
        return json(asks.answer(Number(askPath[1]), text));
      } catch (err) {
        return json({ error: (err as Error).message }, 400);
      }
    }
    if (path === "/notices") return json({ digest: asks.digest() });
    if (path === "/requests") return json({ requests: requests.list({ limit: 50 }), routes: requests.routes() });
    if (path === "/pins" && req.method === "POST") {
      const { action, mode } = await body<{ action: string; mode: asks.PinMode | null }>(req);
      return json(asks.pin(action, mode));
    }
    if (path === "/pins") return json(asks.pins());
    if (path === "/mutes" && req.method === "POST") {
      const { pattern, source } = await body<{ pattern: string; source?: string }>(req);
      return json(asks.mute(pattern, source ?? ""), 201);
    }
    if (path === "/mutes" && req.method === "DELETE") return json({ removed: asks.unmute(Number(url.searchParams.get("id"))) });
    if (path === "/mutes") return json(asks.mutes());
    if (path === "/recall") {
      const q = url.searchParams.get("q") ?? "";
      const sources = url.searchParams.get("sources")?.split(",").filter(Boolean);
      return json(q ? recall.search(q, { sources, limit: Number(url.searchParams.get("limit") ?? 15) }) : recall.stats());
    }

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
