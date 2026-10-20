import { allTasks, auditTrail, follow, notices as fetchMessages } from "./api.ts";
import { ago, clear, el } from "./dom.ts";
import { icon, type IconName } from "./icons.ts";
import { loadReads, markRead, readAt } from "./reads.ts";
import type { AuditEntry, LogMessage, TaskItem } from "./types.ts";

/**
 * The bell in the corner: what was done and what is asked while the user was not looking.
 * Four kinds of thing, and nothing else — an agent's own chatter, a report that merely landed, an
 * event that merely happened are not news:
 *  - an action taken out in the world: an email or a message sent, a page clicked (the audit trail);
 *  - a request to the user (an ask);
 *  - a task started, and a task finished;
 *  - a sub-agent started, and one closed.
 * Opening it lists them newest first, with how many are newer than its last opening; a press on
 * one opens the chat or the task it is about.
 */

const SHOWN = 40;
/** The bell's own place in the daemon's read marks: the same notion every chat uses. */
const BELL = "notices";
/** The log rows that are news: asks to the user, and agents starting and closing. */
const MESSAGE_KINDS = ["ask", "event"] as const;
const AGENT_EVENTS = new Set(["agent.spawned", "agent.closed"]);
const TASK_DONE = new Set(["done", "dropped"]);
/** What an outward tool is about, from its name, for the icon. */
const TOOL_ICONS: readonly (readonly [RegExp, IconName])[] = [
  [/gmail|mail/i, "mail"],
  [/telegram|linkedin|message|send|reply/i, "send"],
  [/calendar|event/i, "calendar"],
  [/browser|click|navigate|playwright/i, "globe"],
  [/^\$|bash|write|edit/i, "terminal"],
];

interface Notice {
  readonly key: string;
  readonly at: number;
  readonly icon: IconName;
  readonly text: string;
  readonly who: string;
  readonly tip?: string;
  readonly open: { readonly agent?: string; readonly id?: number; readonly task?: number };
}

const seen = () => readAt(BELL);
const firstLine = (text: string) => text.replace(/^\[[^\]]+\]\s*/, "").split("\n").find((l) => l.trim()) ?? "";
const nameOf = (slug: string | null | undefined) => (!slug || slug === "pai" ? "pai" : slug === "user" ? "you" : slug.replace(/^(routine|watcher):/, ""));

const fromAudit = (e: AuditEntry): Notice => ({
  key: `audit:${e.toolUseId}`,
  at: e.ts,
  icon: e.ok === false ? "alert" : (TOOL_ICONS.find(([re]) => re.test(`${e.tool} ${e.summary}`))?.[1] ?? "zap"),
  text: e.summary.replace(/^mcp__[^_]+__/, "").replace(/^[a-z-]+:/, (s) => `${s} `),
  who: nameOf(e.agent),
  tip: e.result ?? undefined,
  open: { agent: e.agent ?? "pai" },
});
const fromMessage = (m: LogMessage): Notice | undefined => {
  if (m.kind === "ask") return { key: `m:${m.id}`, at: m.createdAt, icon: "hand", text: m.meta.headline || firstLine(m.body), who: m.meta.breadcrumb?.split(" › ").pop() ?? nameOf(m.from), tip: m.body, open: { agent: m.meta.agent ?? m.from, id: m.id } };
  if (m.kind === "event" && AGENT_EVENTS.has(m.meta.event ?? "")) return { key: `m:${m.id}`, at: m.createdAt, icon: m.meta.event === "agent.closed" ? "circleCheck" : "rocket", text: firstLine(m.body), who: nameOf(m.from), tip: m.body, open: { agent: m.meta.agent ?? m.to, id: m.id } };
  return undefined;
};
const fromTask = (t: TaskItem): Notice[] => {
  const started: Notice = { key: `task:${t.id}:new`, at: t.createdAt ?? 0, icon: "plus", text: `Task #${t.id}: ${t.title}`, who: nameOf(t.owner), tip: t.nextAction, open: { task: t.id } };
  if (!TASK_DONE.has(t.status)) return [started];
  return [{ key: `task:${t.id}:${t.status}`, at: t.updatedAt ?? t.createdAt ?? 0, icon: t.status === "done" ? "circleCheck" : "x", text: `Task #${t.id} ${t.status}: ${t.title}`, who: nameOf(t.owner), tip: t.notes || t.nextAction, open: { task: t.id } }, started];
};

export function noticesBell(root: HTMLElement) {
  const sources = { audit: [] as Notice[], messages: new Map<number, Notice>(), tasks: new Map<number, Notice[]>() };
  let rows: Notice[] = [];
  let open = false;
  const count = el("span.nav-count", { hidden: true });
  const button = el("button.nav-item.nav-bell", { title: "What happened (⌘.)", onclick: () => toggle() }, icon("bell", 15), count);
  const list = el("div.notices-list");
  const pop = el("div.notices", { hidden: true }, el("div.notices-head", {}, "What happened"), list);
  root.append(button, pop);

  const merge = () => {
    rows = [...sources.audit, ...sources.messages.values(), ...[...sources.tasks.values()].flat()].filter((n) => n.at > 0).sort((a, b) => b.at - a.at).slice(0, SHOWN);
    drawCount();
    if (open) drawList();
  };
  const unread = () => rows.filter((n) => n.at > seen()).length;
  // The count is against the daemon's mark, so the marks are asked for and the count drawn again.
  void loadReads().then(() => drawCount());

  const drawCount = () => {
    const n = unread();
    count.textContent = n > 99 ? "99+" : String(n);
    count.hidden = !n || open;
    button.classList.toggle("has-news", n > 0);
  };
  const drawList = () => {
    const mark = seen();
    clear(
      list,
      ...(rows.length
        ? rows.map((n) =>
            el(
              "button.notice-row",
              { class: `notice-row${n.at > mark ? " unread" : ""}`, title: n.tip, onclick: () => (hide(), window.dispatchEvent(new CustomEvent("pai:open", { detail: n.open }))) },
              icon(n.icon, 12),
              el("span.notice-body", {}, el("span.notice-text", {}, n.text), el("span.notice-meta", {}, `${n.who} · ${ago(n.at)}`)),
            ),
          )
        : [el("p.notices-empty", {}, "Nothing yet.")]),
    );
  };

  const hide = () => {
    if (!open) return;
    open = false;
    pop.hidden = true;
    button.classList.remove("on");
    drawCount();
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onKey);
  };
  const onOutside = (e: Event) => !root.contains(e.target as Node) && hide();
  const onKey = (e: KeyboardEvent) => e.key === "Escape" && hide();
  const toggle = () => {
    if (open) return hide();
    open = true;
    drawList();
    // Everything on screen now has been seen; what comes while it is open is new until the next opening.
    if (rows.length) markRead(BELL, Math.max(seen(), rows[0]!.at));
    pop.hidden = false;
    button.classList.add("on");
    drawCount();
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("keydown", onKey);
  };
  window.addEventListener("pai:notices", () => toggle());

  const loadAudit = () => auditTrail(SHOWN).then((all) => ((sources.audit = all.map(fromAudit)), merge()));
  const loadMessages = () =>
    fetchMessages([...MESSAGE_KINDS], SHOWN * 3).then((all) => {
      sources.messages = new Map(all.flatMap((m) => (fromMessage(m) ? [[m.id, fromMessage(m)!] as const] : [])));
      merge();
    });
  const loadTasks = () => allTasks().then((all) => ((sources.tasks = new Map(all.map((t) => [t.id, fromTask(t)]))), merge()));
  const quiet = (p: Promise<unknown>) => p.catch(() => undefined);
  void quiet(loadAudit());
  void quiet(loadMessages());
  void quiet(loadTasks());

  // An outward call settles after it is recorded: the trail is re-read once the turn is quiet.
  let auditTimer: ReturnType<typeof setTimeout> | undefined;
  follow(
    undefined,
    (event) => {
      switch (event.kind) {
        case "message.new": {
          const notice = fromMessage(event.payload as unknown as LogMessage);
          if (notice) sources.messages.set((event.payload as unknown as LogMessage).id, notice), merge();
          break;
        }
        case "task.added":
        case "task.updated": {
          const t = event.payload as unknown as TaskItem;
          sources.tasks.set(t.id, fromTask(t));
          merge();
          break;
        }
        case "session.tool":
        case "session.turn_end":
          clearTimeout(auditTimer);
          auditTimer = setTimeout(() => void quiet(loadAudit()), 1500);
          break;
      }
    },
    { replay: false },
  );
}
