import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The daemon reads its configuration once, at import: a scratch workspace and database first.
const scratch = mkdtempSync(join(tmpdir(), "pai-staff-"));
process.env.PAI_WORKSPACE = join(scratch, "workspace");
process.env.PAI_DB = join(scratch, "pai.db");
process.env.PAI_MAX_AGENTS = "2";
process.env.PAI_QUIET_HOURS = "00:00-00:00";
process.env.PAI_CLAUDE_PROJECTS = join(scratch, "projects");

/**
 * Sessions are Claude Code processes; here they are stand-ins that record what they are told,
 * and a test ends a turn by putting `session.turn_end` on the bus, as a real one would.
 */
class FakeSession {
  static all = new Map<string, FakeSession>();
  readonly id = crypto.randomUUID();
  readonly shortId = this.id.slice(0, 6);
  state: "idle" | "busy" | "dead" = "idle";
  threadId: number | null;
  sent: string[] = [];
  notes: string[] = [];
  pending = undefined;
  agent: string | null;
  constructor(opts: { threadId?: number | null; agent?: { slug: string } }) {
    this.threadId = opts.threadId ?? null;
    this.agent = opts.agent?.slug ?? null;
    FakeSession.all.set(this.id, this);
  }
  send(text: string) {
    if (this.state === "dead") throw new Error("dead");
    this.sent.push(text);
    this.state = "busy";
  }
  inject(text: string) {
    this.notes.push(text);
  }
  kill() {
    this.state = "dead";
  }
  async interrupt() {
    return true;
  }
  persist() {}
  summary() {
    return { sessionId: this.id, state: this.state };
  }
}

mock.module("./sessions.ts", () => ({
  find: (id: string) => FakeSession.all.get(id),
  ensureLive: (id: string) => {
    const s = FakeSession.all.get(id);
    return s && s.state !== "dead" ? s : undefined;
  },
  spawnTask: (opts: { threadId?: number | null; agent?: { slug: string } }) => new FakeSession(opts),
  resolveAgentsWith: () => {},
  list: () => [],
  recent: () => [],
}));

const { bus } = await import("../core/bus.ts");
const { db } = await import("../core/db.ts");
const agents = await import("./agents.ts");
const asks = await import("./asks.ts");
const messages = await import("./messages.ts");
const requests = await import("./requests.ts");
const tasks = await import("./tasks.ts");
const recall = await import("./recall.ts");
const triage = await import("./triage.ts");
const automations = await import("./automations.ts");

/** What pai was told: notes (no turn) and turns. */
const pai = { notes: [] as string[], turns: [] as string[] };
agents.linkPai({ note: (t) => pai.notes.push(t), turn: (t) => pai.turns.push(t) });
requests.linkPai((t) => pai.turns.push(t));
requests.wire();
asks.link({
  priority: (slug) => agents.get(slug)?.priority ?? 0,
  breadcrumb: agents.breadcrumb,
  park: (slug) => slug !== agents.PAI && agents.park(slug),
  deliver: (slug, text, opts) => (slug === agents.PAI ? pai.turns.push(text) : agents.deliver(slug, text, opts)),
  note: (slug, text) => (slug === agents.PAI ? pai.notes.push(text) : agents.noteTo(slug, text)),
});
const stop = agents.start();
afterAll(stop);

const sessionOf = (slug: string) => FakeSession.all.get(agents.get(slug)!.sessionId!)!;
/** Ends the agent's turn with `text`, the way a real session reports one. */
function finish(slug: string, text: string) {
  const s = sessionOf(slug);
  s.state = "idle";
  bus.emitEvent("session.turn_end", { text, costUsd: 0.01, origin: "system" }, s.id);
}

beforeEach(() => {
  pai.notes.length = 0;
  pai.turns.length = 0;
});

describe("tasks", () => {
  it("keeps one list with owners, waiting-on-user first", () => {
    const a = tasks.add({ title: "Plan the trip", owner: "pai" });
    const b = tasks.add({ title: "Reply to Anna", owner: "pai", status: "waiting_user", due: "2026-10-07" });
    tasks.add({ title: "Old thing", status: "done" });
    const open = tasks.list();
    expect(open.map((t) => t.id).slice(0, 2)).toEqual([b.id, a.id]);
    expect(open.some((t) => t.title === "Old thing")).toBe(false);
    expect(tasks.update(a.id, { status: "active", nextAction: "market research" }).nextAction).toBe("market research");
    expect(() => tasks.update(a.id, { status: "someday" as never })).toThrow();
    expect(() => tasks.add({ title: "x", due: "next week" })).toThrow();
  });
});

describe("agents", () => {
  it("makes a folder and a row, with STATE.md pulled into CLAUDE.md", () => {
    const hiring = agents.create({ name: "Hiring", kind: "standing", brief: "Hire people for Hypocrisy.", tools: ["linkedin", "gmail"] });
    expect(hiring.slug).toBe("hiring");
    expect(hiring.parent).toBe("pai");
    expect(readFileSync(join(hiring.folder, "CLAUDE.md"), "utf8")).toContain("@STATE.md");
    expect(existsSync(join(hiring.folder, "STATE.md"))).toBe(true);
    expect(messages.list({ agent: "hiring" }).some((m) => m.meta.event === "agent.created")).toBe(true);
  });

  it("caps depth at three and keeps a sub-agent within its parent's tools", () => {
    const screener = agents.create({ name: "Screener", kind: "sub", brief: "Screen 12 profiles.", tools: ["linkedin", "notion"] }, "hiring");
    expect(screener.parent).toBe("hiring");
    expect(screener.tools).toEqual(["linkedin"]);
    expect(screener.folder).toContain(join("agents", "hiring", "sub"));
    expect(agents.breadcrumb(screener.slug)).toBe("pai › Hiring › Screener");
    expect(() => agents.create({ name: "Deeper", kind: "sub", brief: "x" }, screener.slug)).toThrow(/depth/);
    expect(() => agents.create({ name: "Rogue", kind: "standing", brief: "x" }, "hiring")).toThrow(/only pai/);
    agents.close(screener.slug, "not needed");
  });

  it("wakes an agent with a delegation and passes its report to pai", () => {
    agents.message("hiring", "Post the 2D artist job.", { from: "pai", kind: "delegate" });
    expect(agents.get("hiring")!.status).toBe("working");
    expect(sessionOf("hiring").sent.at(-1)).toContain("Post the 2D artist job.");
    finish("hiring", "Posted on LinkedIn; 3 applicants so far.");
    expect(agents.get("hiring")!.status).toBe("idle");
    agents.flushReports();
    expect(pai.turns.at(-1)).toContain("3 applicants");
    expect(messages.list({ agent: "hiring", kinds: ["report"] }).at(-1)!.to).toBe("pai");
  });

  it("puts a task's delegation and the report it brings into that task's thread", () => {
    const task = tasks.add({ title: "Hire a 2D artist", owner: "hiring" });
    agents.message("hiring", "Shortlist three.", { from: "pai", kind: "delegate", taskId: task.id });
    finish("hiring", "Shortlisted Ana, Bo and Cy.");
    agents.flushReports();
    expect(messages.list({ task: task.id }).map((m) => m.kind)).toEqual(["delegate", "report"]);
    expect(agents.instructionsOf(agents.get("hiring")!).files.map((f) => f.name)).toEqual(["CLAUDE.md", "STATE.md"]);
  });

  it("gathers reports that land together into one turn for pai", () => {
    agents.message("hiring", "How many applicants?", { from: "pai", kind: "delegate" });
    finish("hiring", "Five.");
    agents.message("hiring", "Any replies?", { from: "pai", kind: "delegate" });
    finish("hiring", "Two replied.");
    const before = pai.turns.length;
    agents.flushReports();
    expect(pai.turns.length).toBe(before + 1);
    expect(pai.turns.at(-1)).toContain("Five.");
    expect(pai.turns.at(-1)).toContain("Two replied.");
  });

  it("closes a sub-agent after its one report, which wakes its parent", () => {
    const drafter = agents.create({ name: "Drafter", kind: "sub", brief: "Draft replies." }, "hiring");
    agents.message(drafter.slug, "Draft a reply to Anna.", { from: "hiring", kind: "delegate" });
    finish(drafter.slug, "Draft: Hi Anna, …");
    expect(agents.get(drafter.slug)!.status).toBe("closed");
    expect(sessionOf("hiring").sent.at(-1)).toContain("Drafter reported");
    finish("hiring", "");
  });

  it("sends a report to the agent above, and on up while each one lets it bubble", () => {
    const atma = agents.create({ name: "Atma", kind: "standing", brief: "Run the services." });
    const nested = agents.create({ name: "Hiring two", kind: "standing", brief: "Hire people for Hypocrisy." });
    expect(agents.configure(nested.slug, { parent: atma.slug }).parent).toBe(atma.slug);
    agents.message(nested.slug, "Any news on Keyur?", { from: "pai" });
    const before = pai.turns.length;
    finish(nested.slug, "Keyur passed the screen.");
    agents.flushReports();
    expect(messages.list({ agent: nested.slug, kinds: ["report"] }).at(-1)!.to).toBe(atma.slug);
    expect(sessionOf(atma.slug).sent.at(-1)).toContain("Keyur passed the screen.");
    // Atma passes what it hears up by default, so pai got it too.
    expect(pai.turns.length).toBe(before + 1);
    expect(pai.turns.at(-1)).toContain("Keyur passed the screen.");
    finish(atma.slug, "");
    // Atma told to keep its area to itself: the next report stops there.
    expect(agents.configure(atma.slug, { bubble: false }).bubble).toBe(false);
    agents.message(nested.slug, "And Mira?", { from: "pai" });
    finish(nested.slug, "Mira declined.");
    agents.flushReports();
    expect(sessionOf(atma.slug).sent.at(-1)).toContain("Mira declined.");
    expect(pai.turns.length).toBe(before + 1);
    finish(atma.slug, "");
  });

  it("queues past the working limit and drains as agents finish", () => {
    agents.create({ name: "Travel", kind: "standing", brief: "Plan the trip." });
    agents.create({ name: "Visit", kind: "standing", brief: "Mother's visit." });
    agents.message("hiring", "a", { from: "pai" });
    agents.message("travel", "b", { from: "pai" });
    agents.message("visit", "c", { from: "pai" });
    expect(agents.get("visit")!.status).toBe("queued");
    finish("hiring", "done a");
    expect(agents.get("visit")!.status).toBe("working");
    finish("travel", "done b");
    finish("visit", "done c");
  });

  it("refuses to wake an agent past its daily budget", () => {
    agents.configure("visit", { budget: { turnsPerDay: 1 } });
    agents.message("visit", "again", { from: "pai" });
    expect(agents.get("visit")!.status).toBe("idle");
    agents.flushReports();
    expect(pai.turns.at(-1)).toContain("budget");
    agents.configure("visit", { budget: { turnsPerDay: 40 } });
  });
});

describe("requests", () => {
  it("asks pai to route a new need, then forwards it by code once the route is learned", () => {
    const voice = agents.create({ name: "Voice", kind: "service", brief: "Rewrite in the user's voice." });
    const first = requests.create("hiring", "Rewrite in the user's voice", "Hello candidate");
    expect(pai.turns.at(-1)).toContain(`request #${first.id}`);
    requests.forward(first.id, voice.slug);
    expect(sessionOf(voice.slug).sent.at(-1)).toContain("Hello candidate");
    finish(voice.slug, "Hi! Thanks for applying.");
    expect(requests.get(first.id)!.status).toBe("answered");
    // The answer goes back to Hiring as a turn, logged once.
    expect(sessionOf("hiring").sent.at(-1)).toContain("Thanks for applying");
    expect(messages.list({ agent: "hiring", kinds: ["response"] }).length).toBe(1);
    finish("hiring", "");

    pai.turns.length = 0;
    const second = requests.create("travel", "rewrite in the user's  voice!", "Dear host");
    expect(pai.turns.length).toBe(0);
    expect(requests.get(second.id)!.handler).toBe(voice.slug);
    finish(voice.slug, "Hi, thanks");
    finish("travel", "");
  });

  it("lets pai answer a request itself", () => {
    const r = requests.create("hiring", "approve outbound message", "Hi Anna, the salary is 3k");
    requests.respond(r.id, "approved: Hi Anna, the salary is 3k");
    expect(sessionOf("hiring").sent.at(-1)).toContain("approved");
    finish("hiring", "");
  });
});

describe("asks and notices", () => {
  it("parks an agent on a blocking ask and wakes it with the answer", () => {
    const a = asks.ask({ agent: "hiring", question: "Send the offer to Anna?", options: ["Send", "Edit", "Skip"], context: "Candidate replies" });
    expect(a.delivered).toBe(true);
    expect(agents.get("hiring")!.status).toBe("waiting");
    const row = messages.list({ kinds: ["ask"] }).at(-1)!;
    expect(row.meta.breadcrumb).toBe("pai › Hiring › Candidate replies");
    expect(() => asks.answer(a.id, "Maybe")).not.toThrow(); // free text is allowed by default
    expect(agents.get("hiring")!.status).toBe("working");
    expect(sessionOf("hiring").sent.at(-1)).toContain("Maybe");
    finish("hiring", "");
    expect(asks.open().some((x) => x.id === a.id)).toBe(false);
  });

  it("does not ask again what already waits on the user, and an answer hands the task back", () => {
    const t = tasks.add({ title: "LFS quota full", owner: "hiring", status: "waiting_user" });
    const a = asks.ask({ agent: "pai", question: "LFS quota is full. Fix it how?", blocking: false, fallback: "wait", taskId: t.id });
    expect(asks.ask({ agent: "pai", question: "Buy a data pack?", blocking: false, fallback: "wait", taskId: t.id }).id).toBe(a.id);
    expect(asks.ask({ agent: "pai", question: "The LFS quota is full: fix it how?", blocking: false, fallback: "wait" }).id).toBe(a.id);
    expect(asks.ask({ agent: "pai", question: "Push Atma's commits?", blocking: false, fallback: "wait" }).id).not.toBe(a.id);
    asks.answer(a.id, "prune");
    expect(tasks.get(t.id)!.status).toBe("active");
  });

  it("gives every task waiting on the user an ask of its own, with its row in the chat", () => {
    const before = tasks.add({ title: "Publish the OAuth client", owner: "hiring", status: "waiting_user" });
    const unwire = asks.wireTasks();
    const cardOf = (id: number) => asks.open().find((a) => a.taskId === id);
    // What waited before the wiring is covered too.
    expect(cardOf(before.id)?.options).toEqual([asks.TASK_DID, asks.TASK_SKIP]);
    expect(messages.list({ kinds: ["ask"] }).some((m) => m.taskId === before.id)).toBe(true);
    // The user did their part: the task goes back to its owner, who resumes it.
    asks.answer(cardOf(before.id)!.id, asks.TASK_DID);
    expect(tasks.get(before.id)!.status).toBe("active");
    expect(sessionOf("hiring").sent.at(-1)).toContain("check it and carry on");
    tasks.update(before.id, { status: "waiting_user" });
    asks.answer(cardOf(before.id)!.id, asks.TASK_SKIP);
    expect(tasks.get(before.id)!.status).toBe("dropped");

    const later = tasks.add({ title: "Reconnect the mailbox", owner: "hiring" });
    expect(cardOf(later.id)).toBeUndefined();
    tasks.update(later.id, { status: "waiting_user", nextAction: "Open the link" });
    expect(cardOf(later.id)!.question).toContain("Open the link");
    // Reworded, the card is asked again with the new words; unchanged, it stays the one card.
    const first = cardOf(later.id)!.id;
    tasks.update(later.id, { nextAction: "Open https://x.test and press Reconnect" });
    expect(cardOf(later.id)!.id).not.toBe(first);
    expect(cardOf(later.id)!.question).toContain("press Reconnect");
    const second = cardOf(later.id)!.id;
    tasks.update(later.id, { notes: "still waiting" });
    expect(asks.open().filter((a) => a.taskId === later.id).map((a) => a.id)).toEqual([second]);
    // A real question about the task takes the card's place rather than being swallowed as a repeat.
    const real = asks.ask({ agent: "pai", question: "Which mailbox first?", options: ["Work", "Personal"], blocking: false, fallback: "Work", taskId: later.id });
    expect(asks.open().filter((a) => a.taskId === later.id).map((a) => a.id)).toEqual([real.id]);
    // The task stops waiting: whatever asked about it goes.
    tasks.update(later.id, { status: "active" });
    expect(cardOf(later.id)).toBeUndefined();
    unwire();
  });

  it("only notes a non-blocking ask's answer when it matches the fallback", () => {
    const a = asks.ask({ agent: "hiring", question: "Archive newsletters?", options: ["Yes", "No"], blocking: false, fallback: "Yes" });
    const sent = sessionOf("hiring").sent.length;
    asks.answer(a.id, "yes");
    expect(sessionOf("hiring").sent.length).toBe(sent);
    expect(sessionOf("hiring").notes.at(-1)).toContain("yes");
  });

  it("keeps digest notices for the brief and logs log-priority ones only in the agent's chat", () => {
    asks.notify("hiring", "14 emails filed", "digest");
    asks.notify("hiring", "screened 3 profiles", "log");
    expect(asks.digest().map((n) => n.text)).toContain("14 emails filed");
    expect(messages.list({ kinds: ["notice"] }).at(-1)!.to).toBe("hiring");
    expect(asks.takeDigest().length).toBe(1);
    expect(asks.digest().length).toBe(0);
  });

  it("matches pins by the action's words, longest first", () => {
    asks.pin("send email", "ask");
    asks.pin("send email to the team", "auto");
    expect(asks.pinFor("Send email to a candidate")).toBe("ask");
    expect(asks.pinFor("send email to the team about the build")).toBe("auto");
    expect(asks.pinFor("calendar invite")).toBeUndefined();
  });
});

describe("routines and triage", () => {
  it("checks in code before waking anyone", () => {
    tasks.add({ title: "Candidate: Anna Petrova", owner: "hiring" });
    const event = { kind: "linkedin.message", payload: { with: "Anna Petrova", text: "Hi!" }, ts: Date.now() };
    expect(automations.passes({ matches_open_task: "with" }, event, "hiring")).toBe(true);
    expect(automations.passes({ matches_open_task: "with" }, { ...event, payload: { with: "Someone Else" } }, "hiring")).toBe(false);
    asks.mute("newsletter");
    expect(automations.passes({ not_muted: true }, { kind: "gmail.new", payload: { subject: "Weekly Newsletter" }, ts: 0 })).toBe(false);
    expect(() => automations.create({ name: "bad", schedule: "daily", action: "turn" })).toThrow();
  });

  it("carries out what the small model decided", () => {
    const items = [
      triage.toItem({ kind: "gmail.new", payload: { from: "shop", subject: "receipt", snippet: "" }, ts: 1 }),
      triage.toItem({ kind: "linkedin.message", payload: { with: "Anna Petrova", text: "When is the call?" }, ts: 2 }),
      triage.toItem({ kind: "telegram.dm", payload: { from: "Mom", text: "Landing at 18:00" }, ts: 3 }),
      triage.toItem({ kind: "gmail.new", payload: { from: "bank", subject: "statement", snippet: "" }, ts: 4 }),
    ];
    const before = tasks.list().length;
    triage.apply(items, [
      { i: 0, action: "ignore" },
      { i: 1, action: "wake", agent: "hiring", note: "candidate asks about the call" },
      { i: 2, action: "tell", note: "Mom lands at 18:00" },
    ]);
    expect(sessionOf("hiring").sent.at(-1)).toContain("When is the call?");
    finish("hiring", "");
    expect(messages.list({ kinds: ["notice"] }).at(-1)!.body).toContain("Mom lands");
    // The item the model skipped is filed, not lost.
    expect(tasks.list().length).toBe(before + 1);
  });
});

describe("recall", () => {
  it("finds the message log and transcripts by keyword", async () => {
    messages.log({ from: "pai", to: "user", kind: "chat", body: "The flight from Kyiv lands on Friday" });
    const dir = join(process.env.PAI_CLAUDE_PROJECTS!, "-x-workspace");
    await Bun.write(join(dir, "s1.jsonl"), `${JSON.stringify({ type: "user", timestamp: "2026-10-01T10:00:00Z", message: { role: "user", content: "remind me about the dentist on Tuesday" } })}\n${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } })}\n`);
    expect(await recall.indexTranscripts()).toBe(1);
    expect(await recall.indexTranscripts()).toBe(0);
    expect(recall.search("Kyiv flight")[0]!.source).toBe("message");
    expect(recall.search("dentist")[0]!.source).toBe("transcript");
    expect(recall.search('"o\'brien" AND (')).toEqual([]);
  });
});

describe("a status nothing will clear", () => {
  it("stops calling an agent working when its session is gone", () => {
    const a = agents.create({ name: "Stuck", kind: "standing", brief: "Mind the shop." });
    const session = new FakeSession({ agent: { slug: a.slug } });
    agents.message(a.slug, "go", { from: "pai" });
    // The turn is running: the release it cut restarts the daemon and the session dies with it.
    db.prepare("UPDATE agents SET status = 'working', session_id = ? WHERE slug = ?").run(session.id, a.slug);
    session.state = "dead";
    agents.settle();
    expect(agents.get(a.slug)!.status).toBe("idle");
  });

  it("marks an agent working when a turn of its own is running: a resumed turn is never woken", () => {
    const a = agents.create({ name: "Resumed", kind: "standing", brief: "Mind the shop." });
    const session = new FakeSession({ agent: { slug: a.slug } });
    // What a restart leaves behind: the session resumed, the row reset to idle by the start-up sweep.
    db.prepare("UPDATE agents SET status = 'idle', session_id = ? WHERE slug = ?").run(session.id, a.slug);
    session.state = "busy";
    agents.settle();
    expect(agents.get(a.slug)!.status).toBe("working");
  });

  it("leaves an agent that really is working alone", () => {
    const a = agents.create({ name: "Busy", kind: "standing", brief: "Mind the shop." });
    const session = new FakeSession({ agent: { slug: a.slug } });
    db.prepare("UPDATE agents SET status = 'working', session_id = ? WHERE slug = ?").run(session.id, a.slug);
    session.state = "busy";
    agents.settle();
    expect(agents.get(a.slug)!.status).toBe("working");
  });
});

describe("closing", () => {
  it("archives the folder and closes the sub-agents with it", () => {
    const sub = agents.create({ name: "Booker", kind: "sub", brief: "Book flights." }, "visit");
    const folder = agents.get("visit")!.folder;
    writeFileSync(join(folder, "notes.md"), "flights");
    agents.close("visit", "Mom flew home");
    expect(agents.get("visit")!.status).toBe("closed");
    expect(agents.get(sub.slug)!.status).toBe("closed");
    expect(existsSync(folder)).toBe(false);
    expect(readFileSync(join(agents.get("visit")!.folder, "notes.md"), "utf8")).toBe("flights");
    expect(db.query("SELECT COUNT(*) AS n FROM messages WHERE kind = 'event' AND json_extract(meta, '$.event') = 'agent.closed'").get()).toEqual({ n: 4 }); // screener, drafter, visit, booker
  });
});
