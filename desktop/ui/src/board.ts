import { allTasks, createTask, follow, messages as listMessages, task as fetchTask, updateTask } from "./api.ts";
import { ago, clear, el, fresh, skeleton } from "./dom.ts";
import { icon } from "./icons.ts";
import { kindIcon } from "./kinds.ts";
import { markdown } from "./markdown.ts";
import type { Agent, LogMessage, TaskItem, TaskStatus } from "./types.ts";

/**
 * The task board: the agent tree on the left (pai is the root project, every agent a project
 * under its parent), four columns for the node picked, a card dragged to another column moves
 * the task, a card clicked opens the task beside the board. The database knows seven statuses;
 * the board shows four and remembers the finer one on the card.
 */

const PAI = "pai";
const WEEK = 7 * 86_400_000;

type Column = "todo" | "doing" | "waiting" | "done";
const COLUMNS: readonly { id: Column; label: string; statuses: readonly TaskStatus[] }[] = [
  { id: "todo", label: "Todo", statuses: ["inbox", "scheduled"] },
  { id: "doing", label: "In progress", statuses: ["active", "waiting_other"] },
  { id: "waiting", label: "Waiting on me", statuses: ["waiting_user"] },
  { id: "done", label: "Done", statuses: ["done", "dropped"] },
];
const columnOf = (status: TaskStatus): Column => COLUMNS.find((c) => c.statuses.includes(status))?.id ?? "todo";
const STATUS_LABEL: Record<TaskStatus, string> = { inbox: "inbox", active: "active", waiting_user: "waiting on you", waiting_other: "waiting on others", scheduled: "scheduled", done: "done", dropped: "dropped" };
const KIND_ORDER: Record<Agent["kind"], number> = { orchestrator: 0, standing: 1, service: 2, sub: 3 };

export interface BoardContext {
  readonly agents: () => readonly Agent[];
  readonly openAgent: (slug: string) => void;
  /** The node changed: the address follows. */
  readonly onSelect: (slug: string) => void;
}

export interface Board {
  readonly node: HTMLElement;
  readonly dispose: () => void;
  readonly select: (slug: string) => void;
  readonly refreshAgents: () => void;
}

const firstUrl = (...texts: (string | null | undefined)[]) => texts.map((t) => /https?:\/\/[^\s<>)]+/.exec(t ?? "")?.[0]).find(Boolean);
const today = () => new Date().toISOString().slice(0, 10);

export function board(initial: string | undefined, ctx: BoardContext): Board {
  let tasks: TaskItem[] = [];
  let selected = initial ?? PAI;
  let includeChildren = true;
  let showAllDone = false;
  let openTask: number | undefined;
  const expanded = new Set<number>();

  const bySlug = (slug: string) => ctx.agents().find((a) => a.slug === slug);
  const nameOf = (slug: string) => bySlug(slug)?.name ?? slug;
  const byId = (id: number) => tasks.find((t) => t.id === id);

  const treePane = el("aside.board-tree");
  const main = el("section.board-main");
  const panel = el("aside.board-panel");
  const node = el("div.board-view", {}, treePane, main, panel);
  /** Tasks that arrived since the last draw: their cards come in. */
  const arrived = new Set<number>();
  let loaded = false;

  // ---- the tree ---------------------------------------------------------------------------

  /** Every agent under its parent, closed ones last; an unknown parent means the root. */
  function ordered() {
    const agents = ctx.agents();
    const known = new Set(agents.map((a) => a.slug));
    const children = new Map<string | null, Agent[]>();
    for (const a of agents) {
      const parent = a.parent && known.has(a.parent) ? a.parent : null;
      children.set(parent, [...(children.get(parent) ?? []), a]);
    }
    const out: { agent: Agent; depth: number }[] = [];
    const walk = (parent: string | null, depth: number) => {
      const list = (children.get(parent) ?? []).sort((x, y) => Number(x.status === "closed") - Number(y.status === "closed") || KIND_ORDER[x.kind] - KIND_ORDER[y.kind] || x.name.localeCompare(y.name));
      for (const agent of list) {
        out.push({ agent, depth });
        walk(agent.slug, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }

  /** The slugs under a node, itself included. */
  function subtree(slug: string) {
    const out = new Set([slug]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const a of ctx.agents()) if (a.parent && out.has(a.parent) && !out.has(a.slug)) (out.add(a.slug), (grew = true));
    }
    return out;
  }

  const isOpen = (t: TaskItem) => t.status !== "done" && t.status !== "dropped";

  function drawTree() {
    const rows = ordered().map(({ agent, depth }) => {
      const scope = subtree(agent.slug);
      const own = tasks.filter((t) => scope.has(t.owner) && isOpen(t));
      const counts = COLUMNS.slice(0, 3).map((c) => own.filter((t) => c.statuses.includes(t.status)).length);
      return el(
        "button.agent-row",
        { class: `agent-row${agent.slug === selected ? " on" : ""}${agent.status === "closed" ? " closed" : ""}`, style: `padding-left: ${10 + depth * 14}px`, title: `${agent.name} · ${agent.kind}`, onclick: () => select(agent.slug) },
        el("span", { class: `dot ${{ working: "busy", waiting: "waiting", queued: "queued", idle: "idle", closed: "dead" }[agent.status] ?? ""}` }),
        el("span.label", {}, agent.name),
        el("span.counts", { title: "todo · in progress · waiting on you" }, ...counts.map((n, i) => el("span", { class: `count c-${COLUMNS[i]!.id}${n ? "" : " zero"}` }, String(n)))),
      );
    });
    clear(treePane, el("header.panel-head", {}, icon("board", 13), el("h2", {}, "Projects")), el("div.board-tree-list", {}, ...(rows.length ? rows : [el("p.hint", {}, "No agents yet.")])));
  }

  function select(slug: string) {
    selected = slug;
    ctx.onSelect(slug);
    drawTree();
    drawBoard();
  }

  // ---- the board --------------------------------------------------------------------------

  function visible() {
    const scope = includeChildren ? subtree(selected) : new Set([selected]);
    const cutoff = Date.now() - WEEK;
    return tasks.filter((t) => scope.has(t.owner) && (isOpen(t) || showAllDone || (t.updatedAt ?? 0) >= cutoff));
  }

  const move = async (id: number, column: Column) => {
    const t = byId(id);
    const status = COLUMNS.find((c) => c.id === column)!.statuses[0]!;
    if (!t || columnOf(t.status) === column) return;
    upsert({ ...t, status, updatedAt: Date.now() });
    const result = await updateTask(id, { status });
    if (result.error) {
      upsert(t);
      alert(result.error);
    }
  };

  function card(t: TaskItem, children: TaskItem[]): HTMLElement {
    const column = columnOf(t.status);
    const defaultStatus = COLUMNS.find((c) => c.id === column)!.statuses[0];
    const link = t.source && /^https?:/.test(t.source) ? t.source : firstUrl(t.notes, t.nextAction);
    const open = children.filter(isOpen).length;
    const node = el(
      "div.board-card",
      { class: `board-card status-${t.status}${t.id === openTask ? " on" : ""}`, draggable: "true", "data-task": t.id, onclick: () => void openPanel(t.id) },
      el(
        "div.card-top",
        {},
        el("span.task-title", {}, t.title),
        link ? el("a.iconbtn.slim", { href: link, target: "_blank", rel: "noreferrer", title: link, onclick: (e: Event) => e.stopPropagation() }, icon("link", 11)) : undefined,
      ),
      t.nextAction ? el("div.dim.ellipsis.next", { title: t.nextAction }, t.nextAction) : undefined,
      el(
        "div.task-sub",
        {},
        t.owner === selected ? undefined : el("span.owner", {}, nameOf(t.owner)),
        t.due ? el("span.tag", { class: `tag${t.due <= today() && isOpen(t) ? " due" : ""}`, title: "due" }, t.due) : undefined,
        t.status !== defaultStatus ? el("span.tag.fine", {}, STATUS_LABEL[t.status]) : undefined,
        children.length
          ? el(
              "button.subtasks",
              {
                title: expanded.has(t.id) ? "fold the subtasks" : "show the subtasks",
                onclick: (e: Event) => {
                  e.stopPropagation();
                  if (expanded.has(t.id)) expanded.delete(t.id);
                  else expanded.add(t.id);
                  drawBoard();
                },
              },
              icon("chevron", 10),
              `${open}/${children.length}`,
            )
          : undefined,
      ),
    );
    if (arrived.delete(t.id)) fresh(node);
    node.addEventListener("dragstart", (event) => {
      (event as DragEvent).dataTransfer?.setData("text/plain", String(t.id));
      node.classList.add("dragging");
    });
    node.addEventListener("dragend", () => node.classList.remove("dragging"));
    if (children.length && expanded.has(t.id)) node.append(el("div.subtask-list", {}, ...children.map((c) => subtaskRow(c))));
    return node;
  }

  function subtaskRow(t: TaskItem) {
    return el(
      "button.subtask",
      { class: `subtask status-${t.status}`, onclick: (e: Event) => (e.stopPropagation(), void openPanel(t.id)) },
      icon(isOpen(t) ? "circle" : "check", 10),
      el("span.ellipsis", {}, t.title),
      el("span.tag.fine", {}, STATUS_LABEL[t.status]),
    );
  }

  function drawBoard() {
    const agent = bySlug(selected);
    const list = visible();
    const ids = new Set(list.map((t) => t.id));
    // A task whose parent is on the board sits under it; one whose parent is elsewhere is a card of its own.
    const top = list.filter((t) => !t.parentId || !ids.has(t.parentId));
    const childrenOf = (id: number) => list.filter((t) => t.parentId === id);

    const titleInput = el("input", { type: "text", placeholder: `New task for ${agent?.name ?? selected}…` }) as HTMLInputElement;
    titleInput.addEventListener("keydown", async (event) => {
      if (event.key !== "Enter" || !titleInput.value.trim()) return;
      const title = titleInput.value.trim();
      titleInput.value = "";
      const result = await createTask({ title, owner: selected });
      if (result.error) alert(result.error);
      else if (result.data) upsert(result.data as TaskItem);
    });
    const toggle = (on: boolean, label: string, title: string, flip: () => void) => el("button.seg", { class: `seg${on ? " on" : ""}`, title, onclick: flip }, label);
    const toolbar = el(
      "div.board-toolbar",
      {},
      el("h2", {}, agent?.name ?? selected),
      agent && agent.slug !== PAI ? el("button.iconbtn.slim", { title: `open ${agent.name}'s thread`, onclick: () => ctx.openAgent(agent.slug) }, icon("message", 12)) : undefined,
      el("div.task-new", {}, icon("plus", 12), titleInput),
      el("span.grow"),
      el(
        "div.segmented",
        {},
        toggle(includeChildren, "include children", "fold the subtree's tasks into this board", () => ((includeChildren = !includeChildren), drawBoard())),
        toggle(showAllDone, "all done", "done and dropped older than a week too", () => ((showAllDone = !showAllDone), drawBoard())),
      ),
    );

    const columns = COLUMNS.map((c) => {
      const items = top.filter((t) => columnOf(t.status) === c.id).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      const column = el(
        "section.board-column",
        { class: `board-column col-${c.id}` },
        el("h3.section-title", {}, el("span", {}, c.label), el("span.col-count", {}, String(items.length))),
        el("div.board-cards", {}, ...(!loaded ? [skeleton("lines", 3)] : items.length ? items.map((t) => card(t, childrenOf(t.id))) : [el("p.col-empty", {}, "Nothing here")])),
      );
      column.addEventListener("dragover", (event) => {
        event.preventDefault();
        column.classList.add("over");
      });
      column.addEventListener("dragleave", () => column.classList.remove("over"));
      column.addEventListener("drop", (event) => {
        event.preventDefault();
        column.classList.remove("over");
        const id = Number((event as DragEvent).dataTransfer?.getData("text/plain"));
        if (id) void move(id, c.id);
      });
      return column;
    });
    clear(main, toolbar, el("div.board", {}, ...columns));
  }

  // ---- the side panel: one task in full ---------------------------------------------------

  async function openPanel(id: number) {
    openTask = id;
    node.classList.add("with-panel");
    main.querySelectorAll(".board-card").forEach((c) => c.classList.toggle("on", Number((c as HTMLElement).dataset.task) === id));
    clear(panel, el("header.panel-head", {}, el("span.dim", {}, `#${id}`), el("span.grow"), el("button.iconbtn", { title: "close", onclick: closePanel }, icon("x", 13))), el("div.panel-body", {}, skeleton("lines", 6)));
    const [full, log] = await Promise.all([fetchTask(id).catch(() => undefined), Promise.resolve(byId(id)).then((t) => (t ? listMessages(t.owner, { limit: 300 }).catch(() => []) : []))]);
    if (openTask !== id) return;
    const t = full ?? byId(id);
    if (!t) return clear(panel, el("p.hint", {}, "No such task."));
    drawPanel(t, full?.children ?? tasks.filter((x) => x.parentId === id), log.filter((m) => m.taskId === id));
  }

  function drawPanel(t: TaskItem, children: TaskItem[], log: LogMessage[]) {
    const patch = async (changes: Parameters<typeof updateTask>[1]) => {
      const result = await updateTask(t.id, changes);
      if (result.error) saved.textContent = result.error;
      else {
        saved.textContent = `saved ${ago(Date.now())}`;
        if (result.data) upsert(result.data as TaskItem);
      }
    };
    const saved = el("span.note");
    const title = el("input.panel-title", { type: "text", value: t.title }) as HTMLInputElement;
    title.addEventListener("change", () => title.value.trim() && void patch({ title: title.value.trim() }));
    const owner = el("select", {}, ...ordered().map(({ agent, depth }) => el("option", { value: agent.slug, selected: agent.slug === t.owner }, `${"  ".repeat(depth)}${agent.name}`))) as HTMLSelectElement;
    owner.addEventListener("change", () => void patch({ owner: owner.value }));
    const status = el("select", {}, ...(Object.keys(STATUS_LABEL) as TaskStatus[]).map((s) => el("option", { value: s, selected: s === t.status }, STATUS_LABEL[s]))) as HTMLSelectElement;
    status.addEventListener("change", () => void patch({ status: status.value as TaskStatus }));
    const due = el("input", { type: "date", value: t.due ?? "" }) as HTMLInputElement;
    due.addEventListener("change", () => void patch({ due: due.value || null }));
    const next = el("input", { type: "text", value: t.nextAction, placeholder: "next action" }) as HTMLInputElement;
    next.addEventListener("change", () => void patch({ nextAction: next.value.trim() }));
    const notes = el("textarea", { rows: 5, placeholder: "notes" }, t.notes ?? "") as HTMLTextAreaElement;
    notes.addEventListener("change", () => void patch({ notes: notes.value }));
    const field = (label: string, control: HTMLElement) => el("label.panel-field", {}, el("span", {}, label), control);
    const link = t.source && /^https?:/.test(t.source) ? t.source : firstUrl(t.notes, t.nextAction);
    clear(
      panel,
      el(
        "header.panel-head",
        {},
        el("span.dim", {}, `#${t.id}`),
        link ? el("a.iconbtn.slim", { href: link, target: "_blank", rel: "noreferrer", title: link }, icon("external", 12)) : undefined,
        el("span.grow"),
        saved,
        el("button.iconbtn", { title: "close", onclick: closePanel }, icon("x", 13)),
      ),
      el(
        "div.panel-body",
        {},
        title,
        el("div.panel-grid", {}, field("owner", owner), field("status", status), field("due", due)),
        field("next action", next),
        field("notes", notes),
        t.source ? el("p.dim.panel-source", {}, "source: ", /^https?:/.test(t.source) ? el("a", { href: t.source, target: "_blank", rel: "noreferrer" }, t.source) : t.source) : undefined,
        children.length ? el("section.panel-section", {}, el("h3.section-title", {}, "Subtasks", el("span.dim", {}, String(children.length))), ...children.map(subtaskRow)) : undefined,
        el(
          "section.panel-section",
          {},
          el("h3.section-title", {}, "Messages", el("span.dim", {}, String(log.length))),
          ...(log.length
            ? log.map((m) => el("div.panel-msg", {}, el("div.msg-meta", {}, kindIcon(m.kind === "event" ? (m.meta.event ?? "event") : m.kind, 11), el("b", {}, nameOf(m.from)), el("span.dim", {}, "→"), el("span", {}, nameOf(m.to)), el("span.grow"), el("time", {}, ago(m.createdAt))), el("div.msg-body", {}, markdown(m.body))))
            : [el("p.hint", {}, "Nothing logged about this task.")]),
        ),
        el("p.dim.panel-dates", {}, `created ${t.createdAt ? ago(t.createdAt) : "?"} ago · updated ${t.updatedAt ? ago(t.updatedAt) : "?"} ago`),
      ),
    );
  }

  function closePanel() {
    openTask = undefined;
    node.classList.remove("with-panel");
    main.querySelectorAll(".board-card.on").forEach((c) => c.classList.remove("on"));
  }

  // ---- data -------------------------------------------------------------------------------

  function upsert(t: TaskItem) {
    const index = tasks.findIndex((x) => x.id === t.id);
    if (index >= 0) tasks[index] = { ...tasks[index]!, ...t };
    else {
      tasks.push(t);
      arrived.add(t.id);
    }
    drawTree();
    drawBoard();
  }

  async function load() {
    tasks = await allTasks().catch(() => []);
    loaded = true;
    drawTree();
    drawBoard();
  }

  const stop = follow(
    undefined,
    (event) => {
      if (event.kind === "task.added" || event.kind === "task.updated") upsert(event.payload as unknown as TaskItem);
    },
    { replay: false },
  );

  drawTree();
  drawBoard();
  void load();

  return {
    node,
    dispose: stop,
    select(slug) {
      if (slug === selected) return;
      selected = slug;
      drawTree();
      drawBoard();
    },
    refreshAgents: () => {
      drawTree();
    },
  };
}
