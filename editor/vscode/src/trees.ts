import * as vscode from "vscode";
import { projects, type ProjectSummary, type SessionSummary, tasks, terminals, type TerminalSummary } from "./api.ts";

const icon = (session: SessionSummary) => {
  if (session.waiting) return new vscode.ThemeIcon("question", new vscode.ThemeColor("charts.yellow"));
  if (session.state === "busy" || session.state === "starting")
    return new vscode.ThemeIcon("loading~spin", new vscode.ThemeColor("charts.blue"));
  if (session.state === "idle") return new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("charts.green"));
  return new vscode.ThemeIcon("circle-outline");
};

/** One tree per list; each refreshes itself from the API and fires the view's change event. */
abstract class Tree<T> implements vscode.TreeDataProvider<T> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  refresh() {
    this.changed.fire();
  }

  getChildren(element?: T) {
    return element ? [] : this.load();
  }

  abstract getTreeItem(element: T): vscode.TreeItem;
  protected abstract load(): Promise<T[]>;
}

export class ThreadsTree extends Tree<SessionSummary> {
  protected async load() {
    const { live, recent } = await tasks();
    return [...live, ...recent.filter((r) => !live.some((l) => l.shortId === r.shortId))];
  }

  getTreeItem(session: SessionSummary) {
    const item = new vscode.TreeItem(session.title || session.shortId);
    item.description = [session.kind === "main" ? "main" : session.project, session.state, session.lastTool]
      .filter(Boolean)
      .join(" · ");
    item.tooltip = `${session.shortId}${session.turns ? ` · ${session.turns} turns` : ""}`;
    item.iconPath = icon(session);
    item.contextValue = "thread";
    item.command = { command: "pai.openThread", title: "Open", arguments: [session] };
    return item;
  }
}

export class ProjectsTree extends Tree<ProjectSummary> {
  protected load() {
    return projects();
  }

  getTreeItem(project: ProjectSummary) {
    const item = new vscode.TreeItem(project.slug);
    item.description = project.summary;
    item.tooltip = project.path;
    item.iconPath = new vscode.ThemeIcon("repo");
    item.contextValue = "project";
    item.command = { command: "pai.openProject", title: "Open", arguments: [project] };
    return item;
  }
}

export class TerminalsTree extends Tree<TerminalSummary> {
  protected load() {
    return terminals();
  }

  getTreeItem(terminal: TerminalSummary) {
    const item = new vscode.TreeItem(terminal.project ?? terminal.cwd);
    item.description = terminal.alive ? terminal.id.slice(0, 6) : "dead";
    item.iconPath = new vscode.ThemeIcon("terminal");
    item.contextValue = "terminal";
    item.command = { command: "pai.attachTerminal", title: "Attach", arguments: [terminal] };
    return item;
  }
}
