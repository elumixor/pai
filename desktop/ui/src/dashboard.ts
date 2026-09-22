import {
  automations as listAutomations, baseUrl, contextItems, createAutomation, createContextProject, deleteAutomation, modules as listModules, patchModule, pollModule,
  projects as listProjects, recentEvents, send, status, updateAutomation, usage,
} from "./api.ts";
import { ago, clear, dialog, el, until } from "./dom.ts";
import { editor } from "./editor.ts";
import { icon, type IconName } from "./icons.ts";
import { linkTo, navigate, type Route } from "./router.ts";
import type { Automation, ContextItem, ModuleInfo, ProjectSummary } from "./types.ts";

/**
 * The dashboard: a view of its own, beside the work view. What pai is made of (modules),
 * what makes them act on each other (automations), the projects, and the context — every
 * instruction, memory, skill and tool, with which sessions see it, editable in place.
 */

export interface DashboardHandlers {
  /** Open a file in the work view's editor. */
  readonly openFile: (path: string) => void;
  readonly selectProject: (slug: string) => void;
}

export type Page = "overview" | "modules" | "automations" | "projects" | "context";
const PAGES: { id: Page; label: string; icon: IconName }[] = [
  { id: "overview", label: "Overview", icon: "layout" },
  { id: "modules", label: "Modules", icon: "zap" },
  { id: "automations", label: "Automations", icon: "play" },
  { id: "projects", label: "Projects", icon: "folder" },
  { id: "context", label: "Context", icon: "book" },
];

const minutes = (seconds: number) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
};
const kv = (label: string, value: string | Node | undefined) => (value ? el("div.kv", {}, el("span.k", {}, label), el("span.v", {}, value)) : undefined);
const card = (title: string, ...body: (Node | string | undefined | false)[]) => el("section.card", {}, el("h3", {}, title), ...body);
const link = (href: string, label = href) => el("a", { href, target: "_blank", rel: "noreferrer" }, label, icon("external", 12));
const note = (text: string) => el("p.hint", {}, text);

export function dashboard(root: HTMLElement, handlers: DashboardHandlers) {
  const nav = el("nav.dash-nav");
  const body = el("div.dash-body");
  let page: Page = "overview";
  let disposePage: () => void = () => {};

  const show = async (next: Page) => {
    page = next;
    for (const button of nav.querySelectorAll(".dash-link")) button.classList.toggle("on", (button as HTMLElement).dataset.page === next);
    disposePage();
    disposePage = () => {};
    clear(body, el("p.hint", {}, "…"));
    const renderers: Record<Page, () => Promise<(() => void) | void>> = { overview, modules, automations, projects, context };
    try {
      disposePage = (await renderers[next]()) ?? (() => {});
    } catch (err) {
      clear(body, el("div.notice", {}, el("p", {}, `Cannot reach ${baseUrl()}.`), el("p.dim", {}, (err as Error).message)));
    }
  };

  clear(
    nav,
    el("div.dash-brand", {}, icon("bot", 16), el("span", {}, "pai")),
    ...PAGES.map((p) => linkTo(p.id === "overview" ? "dashboard" : p.id, el("a.dash-link", { "data-page": p.id }, icon(p.icon, 14), el("span", {}, p.label)) as HTMLAnchorElement)),
    el("span.grow"),
    linkTo("work", el("a.dash-link", {}, icon("code", 14), el("span", {}, "Work")) as HTMLAnchorElement),
  );
  clear(root, nav, body);

  // ---- overview -------------------------------------------------------------------------

  async function overview() {
    const [health, quota, events] = await Promise.all([status(), usage().catch(() => undefined), recentEvents(40).catch(() => [])]);
    clear(
      body,
      el("h2.dash-title", {}, "Overview", el("span.dim", {}, health.host.hostname)),
      el(
        "div.cards",
        {},
        card(
          "Daemon",
          kv("version", health.version),
          kv("host", `${health.host.hostname} · ${health.host.platform}`),
          kv("up", minutes(health.uptime)),
          kv("api", link(health.host.api)),
          health.host.publicUrl ? kv("public", link(health.host.publicUrl)) : undefined,
          health.editor.url ? kv("editor", link(health.editor.url)) : undefined,
        ),
        card(
          "Claude",
          ...(quota?.windows.length ? quota.windows.map((w) => kv(w.name, `${w.percent}% used · resets in ${until(w.resetsAt)}`)) : [note(quota?.error ?? "no usage yet")]),
          kv("sessions cost", quota ? `$${quota.costUsd.toFixed(2)}` : undefined),
          kv("models", `${health.settings.models.main} · ${health.settings.models.task}`),
        ),
        card(
          "Setup",
          kv("workspace", health.settings.workspace),
          kv("projects", `${health.counts.projects} under ${health.settings.devRoot}`),
          kv("telegram", health.settings.telegram ? "on" : "off"),
          kv("updates", `${health.settings.updateChannel}${health.settings.autoUpdate ? " · automatic" : ""}`),
        ),
        card(
          "Recent events",
          el(
            "div.event-list",
            {},
            ...events
              .slice()
              .reverse()
              .filter((e) => !e.kind.startsWith("session.delta"))
              .slice(0, 25)
              .map((e) => el("div.event-row", {}, el("span.dim", {}, ago(e.ts)), el("span.tag", {}, e.kind), el("span.ellipsis", {}, summarize(e.payload)))),
          ),
        ),
      ),
    );
  }

  // ---- modules --------------------------------------------------------------------------

  async function modules() {
    const list = await listModules();
    const kinds: Record<ModuleInfo["kind"], string> = { channel: "talks to you", tools: "tools for sessions", source: "watches something", service: "infrastructure" };
    const icons: Record<string, IconName> = { telegram: "send", "tg-user": "user", browser: "globe", tasks: "list", linkedin: "link", gmail: "mail", editor: "code", public: "monitor" };
    const chip = (text: string, title?: string, cls = "") => el("span.chip", { class: `chip ${cls}`, title: title ?? "" }, text);

    const moduleCard = (m: ModuleInfo) => {
      // A module is on, off by its own switch, or waiting for something to be filled in.
      const configured = m.status.configured !== false;
      const toggle = m.settings?.find((s) => s.type === "toggle");
      const state = m.enabled ? "on" : configured ? "off" : "not configured";
      const message = el("span.note");
      const save = async (changes: Record<string, string>) => {
        const result = await patchModule(m.name, changes);
        message.textContent = result.error ?? (result.queued ? "queued" : "saved — restarts the daemon to apply");
        if (!result.error && !result.queued) setTimeout(() => void show("modules"), 1500);
      };

      // Settings: the switch is a chip in the head; the rest a form, hidden until asked for
      // unless something is missing.
      const form = el("div.mod-settings");
      for (const setting of m.settings ?? []) {
        if (setting === toggle) continue;
        const missing = !setting.secret ? !setting.value : setting.value !== "set";
        const input = el("input", {
          type: setting.secret ? "password" : setting.type === "number" ? "number" : "text",
          placeholder: setting.secret ? (setting.value === "set" ? "•••••• (set)" : "paste it here") : (setting.hint ?? ""),
          value: setting.secret ? "" : setting.value,
        }) as HTMLInputElement;
        input.addEventListener("change", () => input.value && void save({ [setting.key]: input.value }));
        form.append(
          el(
            "div.mod-setting",
            { class: `mod-setting${missing && !configured ? " missing" : ""}` },
            el("div.setting-text", {}, el("span.setting-title", {}, setting.label, missing && !configured ? icon("alert", 11) : undefined), setting.hint ? el("span.dim", {}, setting.hint) : undefined),
            input,
          ),
        );
      }
      const hasForm = form.childElementCount > 0;
      form.hidden = configured;

      // The switch: "Turned off" settings are inverted, so on means the value is empty.
      const switchChip = () => {
        if (!toggle) return undefined;
        const inverted = /^PAI_NO_/.test(toggle.key);
        const on = inverted ? toggle.value !== "1" : toggle.value === "1";
        const input = el("input", { type: "checkbox" }) as HTMLInputElement;
        input.checked = on;
        input.addEventListener("change", () => void save({ [toggle.key]: input.checked !== inverted ? "1" : "" }));
        return el("label.switch", { title: `${toggle.label}${toggle.hint ? ` — ${toggle.hint}` : ""}` }, input, el("span"));
      };

      // Accounts: what is connected, each with a way to forget it, and a way to add one.
      const accounts = () => {
        const a = m.accounts;
        if (!a) return undefined;
        const label = el("input", { type: "text", placeholder: a.hint, "aria-label": "label" }) as HTMLInputElement;
        const connect = () => {
          const value = label.value.trim().toLowerCase();
          if (!/^[a-z0-9-]{1,40}$/.test(value)) {
            message.textContent = "a label is letters, digits and dashes";
            return;
          }
          window.open(`${baseUrl()}${a.connectPath.replace("{label}", encodeURIComponent(value))}`, "_blank", "noopener");
          message.textContent = "finish the consent in the tab that opened, then this card refreshes";
          const poll = setInterval(async () => {
            const fresh = (await listModules()).find((x) => x.name === m.name);
            if (fresh?.accounts?.items.some((item) => item.label === value)) {
              clearInterval(poll);
              void show("modules");
            }
          }, 3000);
          setTimeout(() => clearInterval(poll), 5 * 60 * 1000);
        };
        label.addEventListener("keydown", (event) => event.key === "Enter" && connect());
        return el(
          "div.mod-accounts",
          {},
          el(
            "div.chips",
            {},
            ...a.items.map((item) =>
              el(
                "span.chip.account",
                { title: item.detail },
                icon("check", 11),
                el("strong", {}, item.label),
                el("span.dim", {}, item.detail),
                el(
                  "button.iconbtn.slim",
                  {
                    title: `forget ${item.label}`,
                    onclick: async () => {
                      if (!confirm(`Forget ${item.label} (${item.detail})?`)) return;
                      await send(a.removePath.replace("{label}", encodeURIComponent(item.label)), {}, "DELETE");
                      void show("modules");
                    },
                  },
                  icon("trash", 11),
                ),
              ),
            ),
            a.items.length ? undefined : el("span.dim", {}, "nothing connected yet"),
          ),
          el("div.row-inline", {}, label, el("button.btn.primary", { onclick: connect }, icon("plus", 12), "Connect")),
        );
      };

      // What to do about a module that is not on: fill in what it needs, or flip its switch.
      const action = () => {
        if (m.enabled) return undefined;
        if (!configured && hasForm)
          return el("button.btn.primary", { onclick: () => ((form.hidden = !form.hidden), form.querySelector("input")?.focus()) }, icon("settings", 12), "Configure");
        if (!configured) return el("span.dim", {}, "needs the daemon's environment");
        if (toggle) {
          const inverted = /^PAI_NO_/.test(toggle.key);
          return el("button.btn.primary", { onclick: () => void save({ [toggle.key]: inverted ? "" : "1" }) }, icon("power", 12), "Turn on");
        }
        return undefined;
      };

      const statusRow = Object.entries(m.status)
        .filter(([k]) => k !== "configured")
        .map(([k, v]) => {
          const text = typeof v === "object" ? JSON.stringify(v) : String(v);
          const isUrl = /^https?:\/\//.test(text);
          return isUrl ? kv(k, link(text)) : kv(k, text);
        });

      return el(
        "section.card.module",
        { class: `card module ${state.replace(" ", "-")}` },
        el(
          "header.mod-head",
          {},
          el("span.mod-icon", { title: kinds[m.kind] }, icon(icons[m.name] ?? "zap", 15)),
          el("h3", {}, m.title),
          chip(kinds[m.kind], "what kind of module this is"),
          chip(state, m.enabled ? "running" : configured ? "turned off by its switch" : "missing something it needs", `state ${state.replace(" ", "-")}`),
          el("span.grow"),
          message,
          switchChip(),
          hasForm && configured ? el("button.iconbtn.slim", { title: "settings", onclick: () => (form.hidden = !form.hidden) }, icon("settings", 13)) : undefined,
        ),
        el("p.dim", {}, m.description),
        m.tools ? el("div.chips.tools", {}, ...m.tools.names.map((name) => chip(name, `${m.tools!.server} tool, for ${m.tools!.kinds.join(", ")} sessions`, "tool"))) : undefined,
        m.events?.length ? kv("events", m.events.map((e) => `${e.kind} — ${e.description}`).join("; ")) : undefined,
        m.prompt ? el("p.mod-prompt", { title: `what sessions are told (${m.prompt.kinds.join(", ")})` }, m.prompt.text) : undefined,
        statusRow.length ? el("div.kvs", {}, ...statusRow) : undefined,
        accounts(),
        action() ? el("div.row-inline.mod-action", {}, action()) : undefined,
        hasForm ? form : undefined,
        m.live && m.enabled ? el("div.row-inline", {}, el("button.btn", { onclick: async () => (message.textContent = JSON.stringify((await pollModule(m.name)).data ?? {})) }, "Poll now")) : undefined,
      );
    };
    clear(body, el("h2.dash-title", {}, "Modules", el("span.dim", {}, "what pai is made of; a switch or a setting takes effect after the restart it triggers")), el("div.cards.wide", {}, ...list.map(moduleCard)));
  }

  // ---- automations ----------------------------------------------------------------------

  async function automations() {
    const [rules, mods, catalog] = await Promise.all([listAutomations(), listModules(), listProjects()]);
    const knownEvents = [
      ...mods.flatMap((m) => m.events?.map((e) => e.kind) ?? []),
      "session.turn_end",
      "session.question",
      "task.created",
      "daemon.started",
      "daemon.updated",
    ];
    const actions = { notify: "notify me on Telegram", turn: "tell the main conversation", task: "start a task in a project" };
    const form = async (initial?: Automation) => {
      const answer = await dialog({
        title: initial ? "Edit automation" : "New automation",
        description: "When an event with this kind (and, if given, this text somewhere in its payload) happens, run the action. {field} in the message reads the event; empty sends the whole event.",
        fields: [
          { name: "name", label: "Name", value: initial?.name ?? "", required: true },
          { name: "event", label: `Event (${knownEvents.slice(0, 4).join(", ")}, …)`, value: initial?.event ?? "linkedin.message", required: true },
          { name: "filter", label: "Only when the payload contains", value: initial?.filter ?? "" },
          { name: "action", label: "Action: notify · turn · task", value: initial?.action ?? "notify", required: true },
          { name: "project", label: `Project for a task (${catalog.map((p) => p.slug).slice(0, 5).join(", ")}, …)`, value: initial?.project ?? "" },
          { name: "template", label: "Message, e.g. New LinkedIn message from {from}: {text}", value: initial?.template ?? "" },
        ],
        submit: initial ? "Save" : "Create",
      });
      if (!answer) return;
      if (!["notify", "turn", "task"].includes(answer.action ?? "")) return alert("action must be notify, turn or task");
      const result = initial ? await updateAutomation(initial.id, answer as Partial<Automation>) : await createAutomation(answer as Partial<Automation>);
      if (result.error) alert(result.error);
      void show("automations");
    };
    const row = (rule: Automation) =>
      el(
        "div.auto-row",
        { class: `auto-row${rule.enabled ? "" : " off"}` },
        el("span", { class: `dot ${rule.enabled ? "idle" : "dead"}` }),
        el("div.auto-text", {}, el("span.setting-title", {}, rule.name), el("span.dim", {}, `on ${rule.event}${rule.filter ? ` containing "${rule.filter}"` : ""} → ${actions[rule.action]}${rule.project ? ` ${rule.project}` : ""}`)),
        el("span.dim", {}, rule.runs ? `${rule.runs}× · last ${rule.lastRun ? ago(rule.lastRun) : ""}` : "never ran"),
        el("button.iconbtn", { title: rule.enabled ? "disable" : "enable", onclick: async () => (await updateAutomation(rule.id, { enabled: !rule.enabled }), void show("automations")) }, icon(rule.enabled ? "stop" : "play", 13)),
        el("button.iconbtn", { title: "edit", onclick: () => void form(rule) }, icon("settings", 13)),
        el("button.iconbtn", { title: "delete", onclick: async () => (await deleteAutomation(rule.id), void show("automations")) }, icon("x", 13)),
      );
    clear(
      body,
      el("h2.dash-title", {}, "Automations", el("span.grow"), el("button.btn.primary", { onclick: () => void form() }, icon("plus", 13), el("span", {}, "New"))),
      el("p.hint", {}, "on <event> → <action>. Tasks are capped at 6 an hour: each one is a Claude session."),
      rules.length ? el("div.auto-list", {}, ...rules.map(row)) : el("div.empty", {}, el("p.dim", {}, "No automations yet. Try: on linkedin.message → notify.")),
      el("h3.section-title", {}, "Events you can listen to"),
      el("div.chips", {}, ...knownEvents.map((e) => el("span.tag", {}, e))),
    );
  }

  // ---- projects -------------------------------------------------------------------------

  async function projects() {
    const catalog = await listProjects();
    const row = (project: ProjectSummary) =>
      el(
        "div.auto-row",
        {},
        icon(project.kind === "context" ? "book" : "code", 14),
        el("div.auto-text", {}, el("span.setting-title", {}, project.slug), el("span.dim.ellipsis", {}, project.summary || project.path)),
        el("span.tag", {}, project.kind ?? "repo"),
        project.repo ? el("a.iconbtn", { href: project.repo, target: "_blank", rel: "noreferrer", title: project.repo }, icon("github", 13)) : undefined,
        el("button.iconbtn", { title: "edit its CLAUDE.md", onclick: () => handlers.openFile(`${project.path}/CLAUDE.md`) }, icon("file", 13)),
        el("button.iconbtn", { title: "open in the work view", onclick: () => handlers.selectProject(project.slug) }, icon("external", 13)),
      );
    const create = async () => {
      const answer = await dialog({
        title: "New context project",
        description: "A project that is not code: a directory with its own CLAUDE.md (voice, preferences) and its own memory. A job search, hiring, a client.",
        fields: [
          { name: "name", label: "Name", placeholder: "Job search", required: true },
          { name: "about", label: "What it is for", placeholder: "Finding the next role: tracking applications, drafting messages in my voice." },
        ],
        submit: "Create",
      });
      if (!answer) return;
      const result = await createContextProject(answer.name ?? "", answer.about ?? "");
      if (result.error) return alert(result.error);
      const created = result.data as ProjectSummary | undefined;
      if (created) handlers.openFile(`${created.path}/CLAUDE.md`);
    };
    clear(
      body,
      el("h2.dash-title", {}, "Projects", el("span.grow"), el("button.btn.primary", { onclick: () => void create() }, icon("plus", 13), el("span", {}, "New context project"))),
      el("h3.section-title", {}, "Contexts"),
      el("div.auto-list", {}, ...catalog.filter((p) => p.kind === "context").map(row)),
      catalog.some((p) => p.kind === "context") ? undefined : note("None yet. Repositories are projects on their own; a context is for work that has a voice but no code."),
      el("h3.section-title", {}, "Repositories"),
      el("div.auto-list", {}, ...catalog.filter((p) => p.kind !== "context").map(row)),
    );
  }

  // ---- context --------------------------------------------------------------------------

  async function context() {
    const data = await contextItems();
    const groups: Record<ContextItem["kind"], string> = { instruction: "Instructions", memory: "Memory", skill: "Skills", tool: "Tools" };
    const surfaceLabel: Record<string, string> = { main: "main", task: "task", code: "code", terminal: "terminal" };
    const pane = el("div.ctx-editor.panel");
    let disposeEditor: () => void = () => {};
    const open = async (item: ContextItem) => {
      disposeEditor();
      if (item.editable) disposeEditor = (await editor(pane, item.source)) ?? (() => {});
      else clear(pane, el("header.panel-head", {}, icon("book", 13), el("h2", {}, item.name), el("span.dim.ellipsis", {}, item.source)), el("pre.ctx-body", {}, item.body ?? ""));
    };
    const row = (item: ContextItem) =>
      el(
        "button.ctx-row",
        { onclick: () => void open(item), title: item.description },
        el("span.ctx-name.ellipsis", {}, item.name, item.project ? el("span.tag", {}, item.project) : undefined),
        el("span.ctx-desc.dim.ellipsis", {}, item.description),
        ...data.surfaces.map((s) => el("span", { class: `ctx-cell${item.surfaces.includes(s) ? " on" : ""}`, title: `${surfaceLabel[s] ?? s}: ${item.surfaces.includes(s) ? "sees it" : "does not"}` }, item.surfaces.includes(s) ? "●" : "·")),
        item.editable ? icon("file", 12) : el("span.spacer"),
      );
    const header = el("div.ctx-row.head", {}, el("span", {}, "what"), el("span.dim", {}, "from"), ...data.surfaces.map((s) => el("span.ctx-cell.label", { title: surfaceDescription(s) }, surfaceLabel[s] ?? s)), el("span"));
    const list = el("div.ctx-list");
    for (const kind of Object.keys(groups) as ContextItem["kind"][]) {
      const items = data.items.filter((i) => i.kind === kind);
      list.append(el("h3.section-title", {}, groups[kind]), header.cloneNode(true), ...items.map(row));
      if (!items.length) list.append(note("none"));
    }
    clear(
      body,
      el("h2.dash-title", {}, "Context", el("span.dim", {}, "everything a session is given, and who sees it")),
      el("div.ctx-split", {}, list, pane),
    );
    clear(pane, el("div.empty", {}, icon("book", 24), el("p.dim", {}, "Pick an item to read or edit it.")));
    return () => disposeEditor();
  }

  void show(page);
  return { show, page: () => page };
}

const surfaceDescription = (surface: string) =>
  ({
    main: "the main conversation (Telegram root chat, the assistant thread)",
    task: "a task session: its own topic, the workspace or a context project as cwd",
    code: "a coding session in a repository",
    terminal: "claude started in a terminal on this machine — not through pai",
  })[surface] ?? surface;

function summarize(payload: Record<string, unknown>) {
  if (typeof payload.text === "string") return payload.text.replace(/\s+/g, " ").slice(0, 160);
  if (typeof payload.title === "string") return payload.title;
  if (typeof payload.name === "string") return `${payload.name} ${payload.summary ?? ""}`;
  return JSON.stringify(payload).slice(0, 160);
}
