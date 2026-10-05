import { baseUrl, inDesktop, setBaseUrl, setToken, token, usage } from "./api.ts";
import { clear, el } from "./dom.ts";
import { icon, type IconName } from "./icons.ts";
import { prefs, setPrefs } from "./prefs.ts";
import { choice, choose, type Mode } from "./theme.ts";
import { THEMES, type Theme } from "./themes.ts";

export const DOWNLOAD = "https://github.com/elumixor/pai/releases/latest/download/pai-macos.dmg";

const MODES: { value: Mode; label: string; icon: IconName }[] = [
  { value: "system", label: "System", icon: "monitor" },
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
];

export const SHORTCUTS: { keys: string; what: string }[] = [
  { keys: "⌘K", what: "search everything: actions, settings, projects, threads, files" },
  { keys: inDesktop ? "⌘," : "⌘⇧,", what: "settings" },
  { keys: "⌘1 / ⌘2 / ⌘3", what: "work view / dashboard / agents" },
  { keys: "⌃Tab / ⌃⇧Tab", what: "next / previous thread" },
  { keys: "⌃J", what: "focus the terminal (opens one if none)" },
  { keys: "⌃E", what: "focus the editor" },
  { keys: "⌃L", what: "focus the thread's message box" },
  { keys: "⌃B", what: "focus the file tree" },
  { keys: "⌃N", what: "new thread in the selected project" },
  { keys: "⌘S · :w", what: "save the file (it also saves when the editor loses focus)" },
  { keys: "⌘⇧P", what: "markdown: toggle the rendered preview" },
  { keys: "⌘F", what: "reveal the open file in the tree · search in a file is vim's / and ?" },
  { keys: "/", what: "at the start of a message: a slash command (skills, plugins, built-ins)" },
  { keys: "⇧click", what: "open a thread in the lower pane" },
  { keys: "@", what: "in a message: mention a file of the project" },
];

export type SettingsSection = "appearance" | "usage" | "shortcuts" | "connection";
const SECTIONS: { id: SettingsSection; label: string; icon: IconName }[] = [
  { id: "appearance", label: "Appearance", icon: "sun" },
  { id: "usage", label: "Usage rings", icon: "zap" },
  { id: "shortcuts", label: "Shortcuts", icon: "key" },
  { id: "connection", label: "Connection", icon: "link" },
];

/** A theme as a tile: its chrome and a few syntax colours, so the choice is visible before it is made. */
function swatch(theme: Theme, selected: boolean, onpick: () => void) {
  const { ui, syntax } = theme;
  return el(
    "button.swatch",
    { class: `swatch${selected ? " on" : ""}`, title: theme.name, onclick: onpick, style: `--sw-bg:${ui.bg};--sw-panel:${ui.panel};--sw-line:${ui.line};--sw-text:${ui.text}` },
    el(
      "span.sw-preview",
      {},
      el("span.sw-bar", { style: `background:${ui.panel}` }),
      el("span.sw-code", {}, ...[syntax.keyword, syntax.function, syntax.string, syntax.comment, syntax.number, syntax.type].map((color, i) => el("span.sw-line", { style: `background:${color};width:${[46, 70, 58, 80, 40, 64][i]}%` }))),
    ),
    el("span.sw-name", {}, theme.name),
  );
}

interface Row {
  readonly section: SettingsSection;
  readonly title: string;
  readonly hint?: string;
  readonly keywords: string;
  readonly node: HTMLElement;
}

/**
 * The few things that are this app's to decide: how it looks, which usage rings it shows,
 * where the daemon is. Sections on the left, a search that filters every row, the rows on
 * the right. Everything about the daemon itself lives in the dashboard's modules.
 */
export function settingsView(pane: HTMLElement, initial: SettingsSection = "appearance", close?: () => void) {
  const rows: Row[] = [];
  const row = (section: SettingsSection, name: IconName, title: string, hint: string | undefined, control: HTMLElement, keywords = "", stack = false) => {
    const node = el(
      "div.setting",
      { class: `setting${stack ? " stack" : ""}` },
      icon(name, 15),
      el("div.setting-text", {}, el("span.setting-title", {}, title), hint ? el("span.dim", {}, hint) : undefined),
      stack ? el("span") : control,
      stack ? control : undefined,
    );
    rows.push({ section, title, hint, keywords: `${title} ${hint ?? ""} ${keywords}`.toLowerCase(), node });
    return node;
  };

  // ---- appearance ---------------------------------------------------------------------
  const modeRow = el("div.segmented");
  const lightGrid = el("div.swatches");
  const darkGrid = el("div.swatches");
  const paintTheme = () => {
    const chosen = choice();
    clear(modeRow, ...MODES.map((m) => el("button.seg", { class: `seg${chosen.mode === m.value ? " on" : ""}`, onclick: () => (choose({ mode: m.value }), paintTheme()) }, icon(m.icon, 14), el("span", {}, m.label))));
    clear(lightGrid, ...THEMES.filter((t) => t.kind === "light").map((t) => swatch(t, chosen.light === t.id, () => (choose({ light: t.id, mode: "light" }), paintTheme()))));
    clear(darkGrid, ...THEMES.filter((t) => t.kind === "dark").map((t) => swatch(t, chosen.dark === t.id, () => (choose({ dark: t.id, mode: "dark" }), paintTheme()))));
  };
  paintTheme();
  row("appearance", "sun", "Mode", "follows the system unless you pick one", modeRow, "theme light dark system");
  row("appearance", "sun", "Light theme", "picking one switches to light", lightGrid, `theme ${THEMES.filter((t) => t.kind === "light").map((t) => t.name).join(" ")}`, true);
  row("appearance", "moon", "Dark theme", "picking one switches to dark", darkGrid, `theme ${THEMES.filter((t) => t.kind === "dark").map((t) => t.name).join(" ")}`, true);
  if (!inDesktop) row("appearance", "download", "Mac app", "the same client as a window · after installing run xattr -cr /Applications/pai.app once", el("a.btn", { href: DOWNLOAD }, icon("download", 13), el("span", {}, "Download")), "desktop dmg");

  // ---- usage rings --------------------------------------------------------------------
  const ringsBox = el("div.checks", {}, el("span.dim", {}, "…"));
  row("usage", "zap", "Rings in the status bar", "one ring per Claude limit window; hover a ring for the details", ringsBox, "quota limit session weekly fable opus sonnet", true);
  void usage()
    .then((data) => {
      const hidden = new Set(prefs().hiddenRings);
      clear(
        ringsBox,
        ...data.windows.map((w) => {
          const input = el("input", { type: "checkbox" }) as HTMLInputElement;
          input.checked = !hidden.has(w.name);
          input.addEventListener("change", () => {
            const next = new Set(prefs().hiddenRings);
            if (input.checked) next.delete(w.name);
            else next.add(w.name);
            setPrefs({ hiddenRings: [...next] });
          });
          return el("label.check", {}, input, el("span", {}, `${w.name} · ${w.percent}%`));
        }),
        data.windows.length ? undefined : el("span.dim", {}, data.error ?? "no windows reported yet"),
      );
    })
    .catch(() => clear(ringsBox, el("span.dim", {}, "the daemon is not reachable")));

  // ---- shortcuts ----------------------------------------------------------------------
  for (const s of SHORTCUTS) row("shortcuts", "key", s.keys, s.what, el("span"), "keyboard shortcut keybinding");

  // ---- connection ---------------------------------------------------------------------
  const address = el("input", { value: baseUrl(), spellcheck: false }) as HTMLInputElement;
  address.addEventListener("change", () => {
    setBaseUrl(address.value);
    location.reload();
  });
  const secret = el("input", { value: token(), type: "password", placeholder: "none" }) as HTMLInputElement;
  secret.addEventListener("change", () => {
    setToken(secret.value);
    location.reload();
  });
  row("connection", "link", "Daemon", "the pai API this app talks to", address, "address url host");
  row("connection", "key", "Token", "only if the daemon asks for one", secret, "auth secret");

  // ---- layout -------------------------------------------------------------------------
  const search = el("input.settings-search", { placeholder: "Search settings…", spellcheck: false }) as HTMLInputElement;
  const nav = el("nav.settings-nav");
  const body = el("div.settings-body");
  let section: SettingsSection = initial;
  const render = () => {
    const q = search.value.trim().toLowerCase();
    for (const link of nav.querySelectorAll<HTMLElement>(".dash-link")) link.classList.toggle("on", !q && link.dataset.section === section);
    clear(body);
    const visible = rows.filter((r) => (q ? r.keywords.includes(q) : r.section === section));
    let last: SettingsSection | undefined;
    for (const r of visible) {
      if (q && r.section !== last) body.append(el("h3.section-title", {}, SECTIONS.find((s) => s.id === r.section)?.label ?? r.section));
      last = r.section;
      body.append(r.node);
    }
    if (!visible.length) body.append(el("p.hint", {}, "nothing matches"));
  };
  search.addEventListener("input", render);
  clear(nav, ...SECTIONS.map((s) => el("button.dash-link", { "data-section": s.id, onclick: () => ((section = s.id), (search.value = ""), render()) }, icon(s.icon, 14), el("span", {}, s.label))));
  clear(
    pane,
    el(
      "div.settings-layout",
      {},
      el("aside.settings-side", {}, el("div.settings-search-box", {}, icon("zap", 13), search), nav),
      el(
        "div.settings-main",
        {},
        el("header.sheet-head", {}, icon("settings", 14), el("h2", {}, "Settings"), el("span.grow"), el("span.dim.kbd", {}, inDesktop ? "⌘," : "⌘⇧,"), close ? el("button.iconbtn", { title: "close (esc)", onclick: close }, icon("x", 14)) : undefined),
        body,
      ),
    ),
  );
  render();
  search.focus();
}
