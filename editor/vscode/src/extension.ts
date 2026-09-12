import * as vscode from "vscode";
import { follow, post, type ProjectSummary, type SessionSummary, tasks } from "./api.ts";
import { attach, openTerminal } from "./terminal.ts";
import { openThread } from "./thread.ts";
import { ProjectsTree, TerminalsTree, ThreadsTree } from "./trees.ts";

export function activate(context: vscode.ExtensionContext) {
  const threads = new ThreadsTree();
  const projects = new ProjectsTree();
  const terminals = new TerminalsTree();
  const refresh = () => {
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
    vscode.window.registerTreeDataProvider("pai.threads", threads),
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

async function chat() {
  const text = await vscode.window.showInputBox({ prompt: "Message pai" });
  if (!text) return;
  await run(async () => {
    const { live } = await tasks();
    const main = live.find((s) => s.kind === "main");
    await post("/send", { id: "main", text });
    if (main) openThread(main);
  });
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
