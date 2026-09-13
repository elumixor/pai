import { ago, clear, el, json, post } from "../dom.ts";
import type { ProjectSummary, Status } from "../types.ts";

function card(label: string, value: string) {
  return el("div.card", {}, el("span.label", {}, label), el("span.value", {}, value));
}

function pairs(entries: readonly (readonly [string, string])[]) {
  return el("dl.pairs", {}, ...entries.flatMap(([key, value]) => [el("dt", {}, key), el("dd", {}, value)]));
}

export async function overview(pane: HTMLElement) {
  const [status, projects] = await Promise.all([json<Status>("/health"), json<ProjectSummary[]>("/projects")]);

  const restart = el(
    "button.action",
    {
      onclick: async () => {
        restart.textContent = "restarting…";
        await post("/restart", {}).catch(() => undefined);
        setTimeout(() => location.reload(), 4000);
      },
    },
    "Restart daemon",
  );

  const update = el(
    "button.action",
    {
      onclick: async () => {
        update.textContent = "checking…";
        const result = await json<{ behind: number; head: string; target?: string }>("/update");
        update.textContent = result.behind ? `${result.behind} behind ${result.target ?? ""}` : `up to date · ${result.head}`;
      },
    },
    "Check for updates",
  );

  clear(
    pane,
    el(
      "div.cards",
      {},
      card("version", status.version),
      card("uptime", ago(Date.now() - status.uptime * 1000)),
      card("projects", String(status.counts.projects)),
      card("memories", String(status.counts.memories)),
    ),
    el("h2", {}, "Host"),
    pairs([
      ["hostname", status.host.hostname],
      ["platform", status.host.platform],
      ["api", status.host.api],
      ["reachable at", status.host.baseUrl ?? "(not set)"],
      ["telegram", status.settings.telegram ? "on" : "off"],
      ["editor", status.editor.enabled ? `${status.editor.url} ${status.editor.running ? "" : "(starting)"}` : "off"],
    ]),
    el("h2", {}, "Settings"),
    pairs([
      ["workspace", status.settings.workspace],
      ["projects root", status.settings.devRoot],
      ["models", `${status.settings.models.main} · tasks ${status.settings.models.task}`],
      ["updates", `${status.settings.updateChannel} channel, auto ${status.settings.autoUpdate ? "on" : "off"}`],
      ["idle shutdown", `${status.settings.idleShutdownMinutes} min`],
    ]),
    el("h2", {}, "Projects"),
    projects.length
      ? el(
          "div.list",
          {},
          ...projects.map((project) =>
            el("div.row", {}, el("span.grow", {}, project.slug), el("span.dim", {}, project.summary.slice(0, 60) || project.path)),
          ),
        )
      : el("p.empty", {}, `Nothing under ${status.settings.devRoot} yet — clone a repository there and it appears here.`),
    el("h2", {}, "Actions"),
    el("div.crumbs", {}, update, restart),
  );
}
