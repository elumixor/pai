import { Bot, Calendar, Clock, Code, GitBranch, Mail, MessageSquare, Mic, Search, Smartphone, SquareTerminal, Users, Wallet, Wrench, Zap } from "lucide-svelte";
import { modelName } from "../format";
import type { Agent, AgentStatus, Need, SessionSummary } from "../types";

/** A lucide icon: what a row is drawn with. */
export type TreeIcon = typeof Bot;

/**
 * The sidebar's tree: General above it, then every thread under the one that started it — an agent's chat is a
 * thread too, under the agent it reports to, and what an agent's session started hangs under that agent. A thread
 * nothing started (his own, a terminal's, a routine's) is a root. Newest activity first at every level.
 */
export interface TreeNode {
  /** `agent:<slug>` or `thread:<session id>`; General is `pai` and is not a node. */
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly icon: TreeIcon;
  readonly working: boolean;
  /** Decisions waiting on him in this row itself. */
  readonly waiting: number;
  readonly lastActivity: number;
  /** The dev project a thread runs in. */
  readonly project?: string;
  /** The Keep pages a thread works on. */
  readonly keep?: readonly { readonly urn: string; readonly title: string }[];
  /** Whether threads can be put under it: a thread, or an agent with a session. */
  readonly holds: boolean;
  readonly children: TreeNode[];
}

export const PAI = "pai";
export const KIND_ORDER: Record<Agent["kind"], number> = { orchestrator: 0, standing: 1, service: 2, sub: 3 };
const STATUS: Record<AgentStatus, string> = { working: "working", waiting: "waiting on you", queued: "queued", idle: "idle", closed: "closed" };
const KIND_ICON: Record<Agent["kind"], TreeIcon> = { orchestrator: Bot, standing: Bot, service: Zap, sub: GitBranch };
/** An agent's icon from what it is called: the first that fits. */
const AGENT_ICONS: readonly (readonly [RegExp, TreeIcon])[] = [
  [/\b(dev|code|coder|build|engineer)/i, Code],
  [/hir|recruit|people|team|candidate/i, Users],
  [/search|find|scout|research/i, Search],
  [/admin|ops|office|paper/i, Wrench],
  [/balance|calendar|plan|schedul/i, Calendar],
  [/mail|inbox/i, Mail],
  [/budget|financ|invoice|money|account/i, Wallet],
  [/voice|speak/i, Mic],
];
/** Where a thread was started, as its icon says it. */
const ORIGIN_ICON: Record<string, TreeIcon> = { cli: SquareTerminal, terminal: SquareTerminal, phone: Smartphone, builder: Code, routine: Clock };

export const agentIcon = (a: Agent): TreeIcon => AGENT_ICONS.find(([re]) => re.test(`${a.slug} ${a.name}`))?.[1] ?? KIND_ICON[a.kind];
export const threadIcon = (s: SessionSummary): TreeIcon => (s.kind === "code" ? Code : (ORIGIN_ICON[s.origin ?? ""] ?? MessageSquare));
export const threadTitle = (s: SessionSummary) => s.title?.trim() || s.shortId;
const busy = (state: string) => state === "busy" || state === "starting";
const time = (value: number | string | undefined | null) => (typeof value === "number" ? value : value ? Date.parse(value) || 0 : 0);

export interface TreeInput {
  readonly agents: readonly Agent[];
  readonly sessions: readonly SessionSummary[];
  readonly needs: readonly Need[];
  /** The node open now: a closed agent stays listed while it is. */
  readonly open?: string;
  /** pai's own session, which is General even before `/agents` names it. */
  readonly pai?: string;
}

/** Whose sessions they are: an agent's current one and every earlier one of its belong to its node, never a thread's. */
function owners(agents: readonly Agent[], sessions: readonly SessionSummary[], pai?: string) {
  const owner = new Map<string, string>();
  for (const s of sessions) if (s.agent) owner.set(s.sessionId, s.agent);
  for (const a of agents) if (a.sessionId) owner.set(a.sessionId, a.slug);
  if (pai) owner.set(pai, PAI);
  return owner;
}

export function buildTree({ agents, sessions, needs, open, pai }: TreeInput): TreeNode[] {
  const owner = owners(agents, sessions, pai);
  const shown = agents.filter((a) => a.slug !== PAI && (a.status !== "closed" || open === `agent:${a.slug}`));
  const shownSlugs = new Set(shown.map((a) => a.slug));
  const threads = sessions.filter((s) => s.kind !== "main" && !owner.has(s.sessionId));
  const threadIds = new Set(threads.map((t) => t.sessionId));

  const parent = new Map<string, string | null>();
  const nodes = new Map<string, TreeNode>();
  for (const a of shown) {
    parent.set(`agent:${a.slug}`, a.parent && shownSlugs.has(a.parent) ? `agent:${a.parent}` : null);
    const open = a.openTasks ?? 0;
    nodes.set(`agent:${a.slug}`, {
      id: `agent:${a.slug}`,
      label: a.name,
      hint: [`${a.name} · ${a.kind}`, STATUS[a.status] + (a.queued ? ` · ${a.queued} queued` : ""), open ? `${open} open task${open === 1 ? "" : "s"}` : "", a.model ? modelName(a.model) : ""].filter(Boolean).join("\n"),
      icon: agentIcon(a),
      working: a.status === "working",
      waiting: needs.filter((n) => n.agent === a.slug && !(n.session && threadIds.has(n.session))).length,
      lastActivity: a.lastActive ?? a.createdAt ?? 0,
      holds: Boolean(a.sessionId),
      children: [],
    });
  }
  for (const t of threads) {
    const from = t.parent ?? null;
    const by = from ? owner.get(from) : undefined;
    parent.set(`thread:${t.sessionId}`, from && threadIds.has(from) ? `thread:${from}` : by && shownSlugs.has(by) ? `agent:${by}` : null);
    nodes.set(`thread:${t.sessionId}`, {
      id: `thread:${t.sessionId}`,
      label: threadTitle(t),
      hint: [threadTitle(t), t.project ?? "", t.state, t.cwd ?? ""].filter(Boolean).join("\n"),
      icon: threadIcon(t),
      working: busy(t.state),
      waiting: needs.filter((n) => n.session === t.sessionId).length,
      lastActivity: time(t.lastActivity),
      project: t.kind === "code" ? (t.project ?? undefined) : undefined,
      keep: t.keep?.length ? t.keep : undefined,
      holds: true,
      children: [],
    });
  }

  // A parent chain that comes back to itself would hide every row in it: the row where it closes becomes a root.
  for (const id of parent.keys()) {
    const seen = new Set([id]);
    for (let up = parent.get(id); up; up = parent.get(up)) {
      if (seen.has(up)) {
        parent.set(id, null);
        break;
      }
      seen.add(up);
    }
  }

  const roots: TreeNode[] = [];
  for (const [id, node] of nodes) {
    const up = parent.get(id);
    const holder = up ? nodes.get(up) : undefined;
    if (holder) holder.children.push(node);
    else roots.push(node);
  }
  // Agents first (they stand), then what is running now, then the most recently worked on.
  const order = (x: TreeNode, y: TreeNode) =>
    Number(y.id.startsWith("agent:")) - Number(x.id.startsWith("agent:")) || Number(workingIn(y)) - Number(workingIn(x)) || y.lastActivity - x.lastActivity;
  const sort = (list: TreeNode[]) => {
    list.sort(order);
    for (const n of list) sort(n.children);
  };
  sort(roots);
  return roots;
}

/** What waits on him in General itself: pai's own asks and questions, not those of a thread listed below. */
export function generalWaiting(agents: readonly Agent[], sessions: readonly SessionSummary[], needs: readonly Need[], pai?: string) {
  const owner = owners(agents, sessions, pai);
  return needs.filter((n) => (n.agent ?? PAI) === PAI && !(n.session && sessions.some((s) => s.sessionId === n.session) && !owner.has(n.session))).length;
}

/** The ids from the root down to `id`, without it: what has to be unfolded for its row to show. */
export function ancestors(roots: readonly TreeNode[], id: string): string[] | undefined {
  for (const node of roots) {
    if (node.id === id) return [];
    const below = ancestors(node.children, id);
    if (below) return [node.id, ...below];
  }
  return undefined;
}

/** Decisions waiting in a row and every row under it: what a folded row says it hides. */
export const waitingIn = (node: TreeNode): number => node.waiting + node.children.reduce((n, c) => n + waitingIn(c), 0);
export const workingIn = (node: TreeNode): boolean => node.working || node.children.some(workingIn);
