import { api } from "./api";
import { live } from "./stores/live.svelte";
import type { Agent, LogMessage, Need, ProjectSummary, SessionSummary, TaskItem, Usage } from "./types";

export const PAI = "pai";

/**
 * What every view of the room reads: the staff (pai and its agents, with the threads each runs), the open tasks and
 * every task by id, what waits on him, the projects, pai's own session, and the usage windows. Loaded once, kept
 * current from the event stream; a view only draws from it.
 */
class Desk {
  agents = $state<Agent[]>([]);
  /** Open tasks: what the tree and the desks show. */
  tasks = $state<TaskItem[]>([]);
  /** Every task by id, closed ones included, so `#20` in a message can say what it was. */
  taskIndex = $state<Record<number, TaskItem>>({});
  needs = $state<Need[]>([]);
  projects = $state<ProjectSummary[]>([]);
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

  start() {
    if (this.#started) return;
    this.#started = true;
    live.start();
    live.on((event) => this.#onEvent(event.kind, event.payload));
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
    const [agents, tasks, needs, projects, all] = await Promise.all([
      api.agents().catch(() => this.agents),
      api.tasks().catch(() => this.tasks),
      api.needs().catch(() => this.needs),
      api.projects().catch(() => this.projects),
      api.allTasks().catch(() => [] as TaskItem[]),
    ]);
    this.agents = agents;
    this.tasks = tasks;
    this.needs = needs;
    this.projects = projects;
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

  #onEvent(kind: string, payload: Record<string, unknown>) {
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
      // A thread started, answered or ended: the threads under each agent follow.
      case "session.started":
      case "session.exit":
      case "session.titled":
      case "session.turn_end":
      case "task.created":
        clearTimeout(this.#agentsTimer);
        this.#agentsTimer = setTimeout(() => void this.refreshAgents(), kind === "session.started" || kind === "task.created" ? 1500 : 200);
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
