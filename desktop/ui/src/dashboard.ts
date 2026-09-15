import { baseUrl, status, sync, usage } from "./api.ts";
import { clear, el, until } from "./dom.ts";
import { icon } from "./icons.ts";

const minutes = (seconds: number) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
};

/** The daemon at a glance: where it runs, how it is set up, what the subscription has left. */
export async function dashboard(pane: HTMLElement) {
  clear(pane, el("header.sheet-head", {}, icon("layout", 14), el("h2", {}, "Dashboard")), el("p.hint", {}, "…"));
  let health;
  try {
    health = await status();
  } catch {
    clear(pane, el("header.sheet-head", {}, icon("layout", 14), el("h2", {}, "Dashboard")), el("p.hint", {}, `Cannot reach ${baseUrl()}.`));
    return;
  }
  const [quota, syncState] = await Promise.all([usage().catch(() => undefined), sync().catch(() => undefined)]);

  const card = (title: string, ...body: (Node | string | undefined)[]) => el("section.card", {}, el("h3", {}, title), ...body);
  const row = (label: string, value: string | Node | undefined) => (value ? el("div.kv", {}, el("span.k", {}, label), el("span.v", {}, value)) : undefined);
  const link = (href: string, label = href) => el("a", { href, target: "_blank", rel: "noreferrer" }, label, icon("external", 12));

  clear(
    pane,
    el("header.sheet-head", {}, icon("layout", 14), el("h2", {}, "Dashboard"), el("span.dim", {}, health.host.hostname)),
    el(
      "div.cards",
      {},
      card(
        "Daemon",
        row("version", health.version),
        row("host", `${health.host.hostname} · ${health.host.platform}`),
        row("up", minutes(health.uptime)),
        row("api", link(health.host.api)),
        health.host.publicUrl ? row("public", link(health.host.publicUrl)) : undefined,
        health.editor.url ? row("editor", link(health.editor.url)) : undefined,
      ),
      card(
        "Claude",
        ...(quota?.windows.length
          ? quota.windows.map((w) => row(w.name, `${w.percent}% used · resets in ${until(w.resetsAt)}`))
          : [el("p.dim", {}, quota?.error ?? "no usage yet")]),
        row("sessions cost", quota ? `$${quota.costUsd.toFixed(2)}` : undefined),
        row("models", `${health.settings.models.main} · ${health.settings.models.task}`),
      ),
      card(
        "Setup",
        row("workspace", health.settings.workspace),
        row("projects", `${health.counts.projects} under ${health.settings.devRoot}`),
        row("memories", String(health.counts.memories)),
        row("telegram", health.settings.telegram ? "on" : "off"),
        row("updates", `${health.settings.updateChannel}${health.settings.autoUpdate ? " · automatic" : ""}`),
        syncState ? row("sync", syncState.enabled ? (syncState.running ? "running" : "starting") : "off") : undefined,
      ),
    ),
  );
}
