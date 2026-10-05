import * as vscode from "vscode";
import { type AgentSummary, agentLog, follow, post, type ProjectSummary, type SessionSummary } from "./api.ts";
import { attach, openTerminal } from "./terminal.ts";
import { openThread } from "./thread.ts";
import { AgentsTree, ProjectsTree, TerminalsTree, ThreadsTree } from "./trees.ts";

export function activate(context: vscode.ExtensionContext) {
  const staff = new AgentsTree();
  const threads = new ThreadsTree();
  const projects = new ProjectsTree();
  const terminals = new TerminalsTree();
  const refresh = () => {
    staff.refresh();
    threads.refresh();
    projects.refresh();
    terminals.refresh();
  };

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = "pai.chat";
  status.text = "$(hubot) pai";
  status.show();

  context.subscriptions.push(
    status,
    vscode.window.registerTreeDataProvider("pai.agents", staff),
    vscode.window.registerTreeDataProvider("pai.threads", threads),
    vscode.commands.registerCommand("pai.openAgent", (agent: AgentSummary) => run(() => openAgent(agent))),
    vscode.commands.registerCommand("pai.messageAgent", (agent: AgentSummary) => run(() => messageAgent(agent))),
    vscode.window.registerTreeDataProvider("pai.projects", projects),
    vscode.window.registerTreeDataProvider("pai.terminals", terminals),
    vscode.commands.registerCommand("pai.refresh", refresh),
    vscode.commands.registerCommand("pai.openThread", (session: SessionSummary) => openThread(session)),
    vscode.commands.registerCommand("pai.newTask", () => newTask(refresh)),
    vscode.commands.registerCommand("pai.chat", chat),
    vscode.commands.registerCommand("pai.interrupt", (session: SessionSummary) =>
      run(() => post("/stop", { id: session.shortId })),
    ),
    vscode.commands.registerCommand("pai.openTerminal", (target?: ProjectSummary) =>
      run(async () => {
        await openTerminal(target?.slug);
        terminals.refresh();
      }),
    ),
    vscode.commands.registerCommand("pai.attachTerminal", attach),
    vscode.commands.registerCommand("pai.openProject", openProject),
  );

  watch(context, status, refresh);
  refresh();
}

/** The daemon's own event stream drives the views, so nothing polls. A dropped stream retries. */
function watch(context: vscode.ExtensionContext, status: vscode.StatusBarItem, refresh: () => void) {
  const abort = new AbortController();
  context.subscriptions.push({ dispose: () => abort.abort() });

  void (async () => {
    while (!abort.signal.aborted) {
      try {
        for await (const event of follow(undefined, abort.signal)) {
          status.text = event.kind === "session.turn_end" ? "$(hubot) pai" : "$(hubot) pai $(sync~spin)";
          refresh();
        }
      } catch {
        status.text = "$(hubot) pai $(debug-disconnect)";
      }
      if (abort.signal.aborted) return;
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  })();
}

async function newTask(refresh: () => void) {
  const title = await vscode.window.showInputBox({ prompt: "Task title" });
  if (!title) return;
  const text = await vscode.window.showInputBox({ prompt: "First message" });
  if (text === undefined) return;
  const project = vscode.workspace.workspaceFolders?.[0]?.name;
  await run(async () => {
    const session = await post<SessionSummary>("/task", { title, text, project });
    refresh();
    openThread(session);
  });
}

/** A message to pai's one chat; the reply comes back as a notification. */
async function chat() {
  const text = await vscode.window.showInputBox({ prompt: "Message pai" });
  if (!text) return;
  await run(async () => {
    const reply = (await post("/pai", { text, wait: true })) as { text?: string; error?: string };
    if (reply.text) vscode.window.showInformationMessage(reply.text.slice(0, 1000));
  });
}

/** An agent's chat — the message log filtered to it — as a read-only document. */
async function openAgent(agent: AgentSummary) {
  const rows = await agentLog(agent.slug);
  const at = (ms: number) => new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const lines = rows.map((m) => (m.kind === "event" ? `*${at(m.createdAt)} · ${m.body}*` : `**${m.from} → ${m.to}** · ${m.kind} · ${at(m.createdAt)}\n\n${m.body}`));
  const doc = await vscode.workspace.openTextDocument({ language: "markdown", content: `# ${agent.breadcrumb}\n\n${agent.brief}\n\n---\n\n${lines.join("\n\n")}\n` });
  await vscode.window.showTextDocument(doc, { preview: true });
}

/** Writing to an agent directly: pai hears that the user stepped in. */
async function messageAgent(agent: AgentSummary) {
  const text = await vscode.window.showInputBox({ prompt: `Message ${agent.name}` });
  if (text) await post(`/agents/${agent.slug}/message`, { text });
}

/** `pai.sshHost` set means projects live on the box and open over Remote-SSH. */
async function openProject(project: ProjectSummary) {
  const host = vscode.workspace.getConfiguration("pai").get<string>("sshHost");
  const uri = host
    ? vscode.Uri.parse(`vscode-remote://ssh-remote+${host}${project.path}`)
    : vscode.Uri.file(project.path);
  await vscode.commands.executeCommand("vscode.openFolder", uri, { forceNewWindow: true });
}

async function run(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (err) {
    vscode.window.showErrorMessage(`pai: ${(err as Error).message}`);
  }
}

export function deactivate() {}
