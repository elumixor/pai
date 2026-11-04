import { api } from "./api";
import { live } from "./stores/live.svelte";
import type { Agent, LogMessage, Need, SessionSummary, TaskItem, Usage } from "./types";

export const PAI = "pai";

/**
 * What every view reads: the staff (pai and its agents), the sessions the thread tree is built from, the open tasks
 * and every task by id (for the pills in messages), what waits on him, pai's own session, and the usage windows.
 * Loaded once, kept current from the event stream; a view only draws from it.
 */
class Desk {
  agents = $state<Agent[]>([]);
  /** Every session the daemon ran lately, live or not, each once: the threads of the tree. */
  sessions = $state<SessionSummary[]>([]);
  /** Open tasks: what the tree and the desks show. */
  tasks = $state<TaskItem[]>([]);
  /** Every task by id, closed ones included, so `#20` in a message can say what it was. */
  taskIndex = $state<Record<number, TaskItem>>({});
  needs = $state<Need[]>([]);
  paiSession = $state<SessionSummary | undefined>();
  /** The daemon's model for the main chat, for when the session has not answered yet. */
  mainModel = $state<string | undefined>();
  usage = $state<Usage | undefined>();
  hostname = $state("");
  loaded = $state(false);
  online = $state(true);
  #started = false;
  #agentsTimer: ReturnType<typeof setTimeout> | undefined;

  bySlug = (slug: string) => this.agents.find((a) => a.slug === slug);
  nameOf = (slug: string) => (slug === "user" ? "you" : slug === PAI ? "General" : (this.bySlug(slug)?.name ?? slug.replace(/^(watcher|routine):/, "")));
  taskOf = (id: number) => this.taskIndex[id] ?? this.tasks.find((t) => t.id === id);
  threadOf = (id: string) => this.sessions.find((s) => s.sessionId === id || s.shortId === id);

  start() {
    if (this.#started) return;
    this.#started = true;
    live.start();
    live.on((event) => this.#onEvent(event.kind, event.payload, event.sessionId));
    live.onReconnect(() => void this.load());
    void this.load();
    void this.refreshUsage();
    setInterval(() => void this.refreshUsage(), 60_000);
    void api
      .status()
      .then((s) => {
        this.mainModel = s.settings.models.main;
        this.hostname = s.host.hostname;
      })
      .catch((error) => console.warn("[desk] no status", error));
  }

  async load() {
    const [agents, tasks, needs, all] = await Promise.all([
      api.agents().catch(() => this.agents),
      api.tasks().catch(() => this.tasks),
      api.needs().catch(() => this.needs),
      api.allTasks().catch(() => [] as TaskItem[]),
      this.refreshSessions(),
    ]);
    this.agents = agents;
    this.tasks = tasks;
    this.needs = needs;
    this.taskIndex = Object.fromEntries(all.map((t) => [t.id, t]));
    this.loaded = true;
    void this.refreshPai();
  }

  async refreshPai() {
    try {
      this.paiSession = (await api.pai()).session;
    } catch (error) {
      console.warn("[desk] pai's session unavailable", error);
    }
    return this.paiSession?.sessionId;
  }

  async refreshNeeds() {
    this.needs = await api.needs().catch(() => this.needs);
  }

  async refreshAgents() {
    this.agents = await api.agents().catch(() => this.agents);
  }

  /** The running sessions over the recent rows: a live one's state is the current one. */
  async refreshSessions() {
    const found = await api.sessions().catch(() => undefined);
    if (!found) return;
    const byId = new Map<string, SessionSummary>();
    for (const s of found.recent) byId.set(s.sessionId, s);
    for (const s of found.live) byId.set(s.sessionId, { ...byId.get(s.sessionId), ...s });
    this.sessions = [...byId.values()];
  }

  /**
   * Puts tree rows under another (`agent:<slug>` / `thread:<id>`) or at the top (`null`): a thread goes under a thread
   * or an agent, an agent only under an agent. Shown at once, then read back.
   */
  async move(ids: readonly string[], target: string | null) {
    const threads = ids.filter((id) => id.startsWith("thread:")).map((id) => id.slice("thread:".length));
    const agents = ids.filter((id) => id.startsWith("agent:")).map((id) => id.slice("agent:".length));
    const parentSession = target?.startsWith("thread:") ? target.slice("thread:".length) : target?.startsWith("agent:") ? this.bySlug(target.slice("agent:".length))?.sessionId ?? null : null;
    if (threads.length && (!target || parentSession)) {
      this.sessions = this.sessions.map((s) => (threads.includes(s.sessionId) && s.sessionId !== parentSession ? { ...s, parent: parentSession } : s));
      const sent = await api.moveThreads(threads, target);
      if (sent.error) console.warn("[move]", sent.error);
    }
    const agentParent = target === null ? PAI : target.startsWith("agent:") ? target.slice("agent:".length) : null;
    if (agentParent) for (const slug of agents) if (slug !== agentParent) await api.configureAgent(slug, { parent: agentParent });
    await Promise.all([this.refreshSessions(), agents.length ? this.refreshAgents() : undefined]);
  }

  /** A session's state as an event says it, before the next refresh brings the rest. */
  #setState(id: string | undefined, state: string) {
    const index = id ? this.sessions.findIndex((s) => s.sessionId === id) : -1;
    if (index >= 0) this.sessions[index] = { ...this.sessions[index]!, state, lastActivity: Date.now() };
  }

  async refreshUsage() {
    try {
      this.usage = await api.usage();
      this.online = true;
    } catch {
      this.online = false;
    }
  }

  upsertTask(t: TaskItem) {
    this.taskIndex = { ...this.taskIndex, [t.id]: { ...this.taskIndex[t.id], ...t } };
    const open = t.status !== "done" && t.status !== "dropped";
    const index = this.tasks.findIndex((x) => x.id === t.id);
    if (index >= 0) {
      if (open) this.tasks[index] = { ...this.tasks[index]!, ...t };
      else this.tasks.splice(index, 1);
    } else if (open) this.tasks.push(t);
  }

  #onEvent(kind: string, payload: Record<string, unknown>, sessionId?: string) {
    this.online = true;
    switch (kind) {
      case "message.new": {
        const m = payload as unknown as LogMessage;
        if (m.kind === "ask" || m.kind === "answer") void this.refreshNeeds();
        break;
      }
      case "task.added":
      case "task.updated": {
        const t = payload as unknown as TaskItem;
        if (typeof t?.id !== "number") break;
        this.upsertTask(t);
        if (t.status === "waiting_user" || (payload as { previous?: string }).previous === "waiting_user") void this.refreshNeeds();
        break;
      }
      case "agent.changed":
      case "agent.created": {
        const changed = payload as unknown as Agent;
        const index = this.agents.findIndex((a) => a.slug === changed.slug);
        if (index < 0) void this.refreshAgents();
        else this.agents[index] = { ...this.agents[index]!, ...changed };
        break;
      }
      // A turn began: the thread works from now on.
      case "session.input":
        this.#setState(sessionId, "busy");
        break;
      // A thread started, answered or ended: the staff and the tree follow.
      case "session.started":
      case "session.resumed":
      case "session.exit":
      case "session.titled":
      case "session.turn_end":
      case "task.created":
        if (kind === "session.turn_end") this.#setState(sessionId, "idle");
        clearTimeout(this.#agentsTimer);
        this.#agentsTimer = setTimeout(() => void Promise.all([this.refreshAgents(), this.refreshSessions()]), kind === "session.started" || kind === "task.created" ? 1500 : 200);
        break;
      case "session.question":
      case "session.answer":
      case "ask.created":
      case "ask.answered":
        void this.refreshNeeds();
        break;
      case "main.rotated":
        void this.refreshPai();
        break;
    }
  }
}

export const desk = new Desk();
