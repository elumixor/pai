import { MAX_FILES, readable, serve as serveAttachment, type Upload } from "../domain/attachments.ts";
import * as drafts from "../domain/drafts.ts";
import { mapResponse } from "../domain/maps.ts";
import { ratesResponse } from "../domain/rates.ts";
import * as reads from "../domain/reads.ts";
import * as keep from "../domain/keep.ts";
import * as projects from "../domain/projects.ts";
import * as automations from "../domain/automations.ts";
import { context, save as saveContext } from "../domain/context.ts";
import { byName as moduleByName, describeModules } from "../modules/index.ts";
import * as external from "../connectors/loader.ts";
import { info as telegramInfo } from "../clients/telegram.ts";
import { needsLogin, usage } from "../domain/usage.ts";
import * as claudeLogin from "../domain/claude-login.ts";
import { recentEvents, waitFor } from "../core/bus.ts";
import * as sessions from "../domain/sessions.ts";
import * as held from "../domain/held.ts";
import * as terminals from "../domain/terminals.ts";
import { status as updateStatus, update } from "../domain/update.ts";
import { logger } from "../core/log.ts";
import { events } from "./events.ts";
import { messagePage } from "./message.ts";
import { status } from "./status.ts";
import * as settings from "../domain/settings.ts";
import { allThreads, ensureTranscriptAt, sessionsIn, toolCall, transcript } from "../domain/transcript.ts";
import { cost as hostingCost } from "../domain/hetzner.ts";
import * as models from "../domain/models.ts";
import * as spend from "../domain/spend.ts";
import * as agents from "../domain/agents.ts";
import * as push from "../domain/push.ts";
import * as asks from "../domain/asks.ts";
import * as main from "../domain/main.ts";
import * as messages from "../domain/messages.ts";
import * as summaries from "../domain/summaries.ts";
import * as recall from "../domain/recall.ts";
import * as audit from "../domain/audit.ts";
import * as tasks from "../domain/tasks.ts";
import { importPrompt, snapshot } from "../domain/snapshot.ts";

const log = logger("api");

/**
 * What a client may attach, checked at the door. A file the model cannot read is refused here with
 * the reason, so he hears it while he is attaching rather than from a turn that gave up on it.
 */
function refuse(uploads: readonly Upload[] | undefined): string | undefined {
  if (!uploads?.length) return undefined;
  if (uploads.length > MAX_FILES) return `${uploads.length} files at once; ${MAX_FILES} is the limit`;
  for (const upload of uploads) {
    const why = readable(upload);
    if (why) return why;
  }
  return undefined;
}

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
    // Modules' paths outside /m/ (a mailbox's /gmail/connect), behind the same auth as everything here.
    const mounted = await external.mounted(req, url);
    if (mounted) return mounted;

    if (path === "/health") return json(await status());

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

    // A picture someone attached, by the name the transcript gives it.
    if (path.startsWith("/attachments/"))
      return serveAttachment(path.slice("/attachments/".length), url.searchParams.get("name") ?? undefined) ?? json({ error: "no such attachment" }, 404);

    // A draft he is approving: the card's fields, his edits, his Send and his Discard.
    if (path === "/drafts") return json({ drafts: drafts.open(), shape: drafts.SHAPE });
    const draftPath = /^\/drafts\/(\d+)(?:\/(send|discard))?$/.exec(path);
    if (draftPath?.[1]) {
      const id = Number(draftPath[1]);
      try {
        if (draftPath[2] === "send" && req.method === "POST") {
          // What he edited goes with it: the body arrives on the Send, so the card he is looking at
          // is what is sent even if the last keystroke never reached a PATCH.
          const edits = await body<Partial<drafts.Fields>>(req).catch(() => ({}) as Partial<drafts.Fields>);
          if (Object.keys(edits).length) drafts.edit(id, edits);
          return json(drafts.send(id));
        }
        if (draftPath[2] === "discard" && req.method === "POST") {
          const { why } = await body<{ why?: string }>(req).catch(() => ({ why: "" }));
          return json(drafts.discard(id, why ?? ""));
        }
        if (req.method === "PATCH") return json(drafts.edit(id, await body<Partial<drafts.Fields>>(req)));
        const found = drafts.get(id);
        return found ? json(found) : json({ error: "no such draft" }, 404);
      } catch (err) {
        return json({ error: (err as Error).message }, 400);
      }
    }

    // How far he has read, per chat: the box holds it, so every client agrees.
    if (path === "/reads" && req.method === "POST") {
      const { place, at } = await body<{ place?: string; at?: number }>(req);
      return json({ marks: reads.mark(String(place ?? ""), Number(at ?? 0)) });
    }
    if (path === "/reads") return json({ marks: reads.marks() });

    // What a currency is worth, for showing an amount in the ones he thinks in.
    if (path === "/rates") return await ratesResponse();

    // A place's map picture: OpenStreetMap tiles stitched into an SVG, cached on the box.
    if (path === "/map") return (await mapResponse(url.searchParams)) ?? json({ error: "lat and lon required" }, 400);

    // A session's model and effort from now on; its process restarts on the next message.
    if (path === "/reconfigure" && req.method === "POST") {
      const { id, model, effort } = await body<{ id: string; model?: string | null; effort?: "low" | "medium" | "high" | "xhigh" | "max" | null }>(req);
      try {
        return json(sessions.reconfigure(id, { model, effort }));
      } catch (err) {
        return json({ error: (err as Error).message }, 409);
      }
    }

    // The slash commands a session's process accepts; a session that is not live falls back to any live one's.
    if (path === "/commands") {
      const s = sessions.find(url.searchParams.get("session") ?? "");
      const any = [...sessions.list()].map((x) => sessions.find(x.sessionId)).find((x) => x?.commands.length);
      return json(s?.commands.length ? s.commands : (any?.commands ?? []));
    }

    // A thread's conversation as it is on disk, which is what `claude --resume` shows.
    if (path === "/transcript") {
      const raw = url.searchParams.get("session") ?? "";
      const session = sessions.find(raw);
      const id = session?.id ?? sessions.resolveId(raw) ?? raw;
      const limit = Number(url.searchParams.get("limit") ?? 200);
      return json(await transcript(id, session?.cwd ?? url.searchParams.get("cwd") ?? undefined, limit));
    }

    // One tool call in full: the transcript keeps the input and the output the previews cut.
    if (path === "/transcript/tool") {
      const raw = url.searchParams.get("session") ?? "";
      const session = sessions.find(raw);
      const id = session?.id ?? sessions.resolveId(raw) ?? raw;
      const call = await toolCall(id, url.searchParams.get("tool") ?? "", session?.cwd ?? url.searchParams.get("cwd") ?? undefined);
      return call ? json(call) : json({ error: "no such tool call" }, 404);
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

    // A project is added by cloning a repository (through the module that keeps them), or as a context: a
    // directory in the workspace with instructions and memory of its own.
    if (path === "/projects" && req.method === "POST") {
      const { url: source, name, about } = await body<{ url?: string; name?: string; about?: string }>(req);
      try {
        return json(source ? projects.clone(source, name) : projects.createContext(name ?? "", about), 201);
      } catch (err) {
        if (err instanceof projects.ProjectError) return json({ error: err.message }, 400);
        throw err;
      }
    }

    if (path === "/projects") return json(url.searchParams.get("refresh") ? projects.refresh() : projects.all());

    // The subscription's limits and what the sessions have cost, for the clients' status line.
    if (path === "/usage") return json({ ...(await usage()), needsLogin: needsLogin() });

    // This machine's own Claude login: the page that reconnects it, and the code pasted back.
    if (path === claudeLogin.LOGIN_PATH && req.method === "GET") return claudeLogin.page();
    if (path === `${claudeLogin.LOGIN_PATH}/code` && req.method === "POST") {
      try {
        return json(await claudeLogin.finish((await body<{ code: string }>(req)).code ?? ""));
      } catch (err) {
        return json({ error: (err as Error).message }, 400);
      }
    }
    if (path === "/claude/status") return json(await claudeLogin.status());

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
      // A conversation held elsewhere (a terminal's) goes there; its module resumes it here when it cannot.
      const elsewhere = !sessions.find(id) ? held.find(id) : undefined;
      if (elsewhere && !wait) {
        elsewhere.send(text, { images });
        return json(elsewhere.summary());
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

    // What each kind of session is given, for the dashboard.
    if (path === "/context" && req.method === "PUT") {
      const { name, text } = await body<{ name: string; text: string }>(req);
      return json(saveContext(name, text));
    }
    if (path === "/context") return json(context());

    // The bot's public face: pai's own Telegram client, at the path it had while it lived in the telegram module.
    if (path === "/m/telegram/info") {
      const info = telegramInfo();
      return info ? json(info) : json({ error: "the bot is off" }, 503);
    }
    // A connector's own http, under its name; anything else under /m/ is a message page (below).
    if (path.startsWith("/m/")) {
      const answered = await external.route(req, url);
      if (answered) return answered;
    }

    // The channel connectors in one shape, with each one's status.
    if (path === "/connectors") return json(await external.connectors());
    if (path === "/keep/events" && req.method === "POST") {
      try {
        return json(keep.receive(await req.text(), req.headers.get("x-keep-signature")));
      } catch (err) {
        if (err instanceof keep.KeepSignatureError) return json({ error: err.message }, 401);
        throw err;
      }
    }
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
      if (modulePath[2] === "update" && req.method === "POST") return json({ ...(await external.update(name, l.source)), restartRequired: true });
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

    // Claude's models as the API lists them, and the newest of each family (what `opus`, `sonnet`… resolve to).
    if (path === "/models") return json({ latest: models.latest(), all: models.list() });

    // Where the time, tokens and money went over the last `days`: API price next to the real one.
    if (path === "/spend") return json(await spend.report(Math.max(1, Math.min(365, Number(url.searchParams.get("days") ?? 30) || 30))));

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
          const { text, taskId, images, files } = await body<{ text: string; taskId?: number; images?: Upload[]; files?: Upload[] }>(req);
          const attached = [...(images ?? []), ...(files ?? [])];
          const no = refuse(attached);
          if (no) return json({ error: no }, 400);
          if (!text?.trim() && !attached.length) return json({ error: "text required" }, 400);
          if (slug === agents.PAI) return json({ session: main.send(text ?? "", { images: attached }).shortId });
          return json(agents.fromUser(slug, text ?? "", taskId, attached));
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

    // One row of the log, for a `^<id>` reference in a message somewhere else.
    const messagePath = /^\/messages\/(\d+)$/.exec(path);
    if (messagePath?.[1]) {
      const row = messages.get(Number(messagePath[1]));
      return row ? json(row) : json({ error: "no such message" }, 404);
    }

    // The gist of one message, written on first request and kept.
    const headlinePath = /^\/messages\/(\d+)\/headline$/.exec(path);
    if (headlinePath?.[1]) return json({ headline: (await summaries.headline(Number(headlinePath[1]))) ?? null, enabled: summaries.enabled() });
    const tldrPath = /^\/messages\/(\d+)\/tldr$/.exec(path);
    if (tldrPath?.[1]) return json({ tldr: (await summaries.tldr(Number(tldrPath[1]))) ?? null, enabled: summaries.enabled() });

    // The message log: one agent's chat (`agent`), paged back with `before`, caught up with `after`.
    if (path === "/messages") {
      const num = (k: string) => (url.searchParams.get(k) ? Number(url.searchParams.get(k)) : undefined);
      const kinds = url.searchParams.get("kinds")?.split(",").filter(Boolean) as messages.MessageKind[] | undefined;
      return json(messages.list({ agent: url.searchParams.get("agent") ?? undefined, task: num("task"), before: num("before"), after: num("after"), limit: num("limit"), kinds }));
    }

    // A message to pai, the one chat; `wait` holds the response until pai has answered.
    if (path === "/pai" && req.method === "POST") {
      const { text, wait, images, files } = await body<{ text: string; wait?: boolean; images?: Upload[]; files?: Upload[] }>(req);
      const attached = [...(images ?? []), ...(files ?? [])];
      const no = refuse(attached);
      if (no) return json({ error: no }, 400);
      if (!text?.trim() && !attached.length) return json({ error: "text required" }, 400);
      const s = main.session();
      const done = wait ? waitFor("session.turn_end", s.id, TURN_TIMEOUT) : undefined;
      main.send(text ?? "", { images: attached });
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
      // A draft waiting on him is a decision with a card of its own: Send or Discard, after editing.
      const fromDrafts = drafts.open().map((d) => ({
        kind: "draft" as const,
        id: `draft:${d.id}`,
        draftId: d.id,
        taskId: d.taskId ?? undefined,
        agent: area(d.agent),
        from: agents.get(d.agent)?.name ?? d.agent,
        question: `${drafts.labelFor(d.channel)}${d.fields.to ? ` to ${d.fields.to}` : ""}${d.fields.subject ? `: ${d.fields.subject}` : ""}`,
        options: d.status === "sending" ? [] : ["Send", "Discard"],
        freeText: false,
        priority: "normal",
        draft: { channel: d.channel, fields: d.fields, status: d.status, state: d.state, note: d.note },
        createdAt: d.createdAt,
      }));

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
        options: [asks.TASK_DID, asks.TASK_SKIP],
        freeText: true,
        priority: "normal",
        link: tasks.firstUrl(t.nextAction, t.source, t.notes),
        createdAt: t.updatedAt,
      }));
      return json([...fromSessions, ...fromDrafts, ...fromAsks, ...fromTasks].sort((a, b) => b.createdAt - a.createdAt));
    }

    // A phone's APNs token (Paigram registers itself), and a test push to every phone.
    if (path === "/push/devices" && req.method === "POST") {
      const { token, bundleId, env } = await body<{ token?: string; bundleId?: string; env?: push.ApnsEnv }>(req);
      if (!token || !bundleId) return json({ error: "token and bundleId required" }, 400);
      push.register({ token, bundleId, env: env === "sandbox" ? "sandbox" : "production" });
      return json({ registered: true });
    }
    if (path === "/push/devices" && req.method === "DELETE") return json({ removed: push.unregister(url.searchParams.get("token") ?? "") });
    if (path === "/push/test" && req.method === "POST") {
      const { title, body: text } = await body<{ title?: string; body?: string }>(req);
      return json({ delivered: await push.notify({ title: title ?? "pai", body: text ?? "Push works." }) });
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
          let choice = text.trim().toLowerCase();
          if (choice === asks.TASK_DID.toLowerCase()) {
            tasks.update(t.id, { status: "active" });
            const said = `[the user says they did what task #${t.id} "${t.title}" waited on: check it and carry on]`;
            if (t.owner === agents.PAI) main.send(said);
            else agents.fromUser(t.owner, said);
            return json({ answered: true });
          }
          if (choice === asks.TASK_SKIP.toLowerCase()) choice = "drop";
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
    // What the sessions did outside the daemon: sends, posts, writes, clicks in signed-in sites.
    // The state of things as one markdown document; posted back (to this or another pai), it becomes pai's turn to rebuild from.
    if (path === "/snapshot" && req.method === "POST") {
      const { text } = await body<{ text: string }>(req);
      if (!text?.trim()) return json({ error: "text required" }, 400);
      return json({ session: main.send(importPrompt(text)).shortId });
    }
    if (path === "/snapshot") return json({ text: snapshot() });
    if (path === "/audit") {
      const p = url.searchParams;
      return json(audit.list({ agent: p.get("agent") ?? undefined, search: p.get("q") ?? undefined, since: Number(p.get("since")) || undefined, limit: Number(p.get("limit") ?? 50) }));
    }
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
