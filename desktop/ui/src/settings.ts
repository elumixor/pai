import { baseUrl, inDesktop, setBaseUrl, setToken, token } from "./api.ts";
import { clear, el } from "./dom.ts";
import { icon, type IconName } from "./icons.ts";
import { choice, choose, type Mode } from "./theme.ts";
import { THEMES, type Theme } from "./themes.ts";

export const DOWNLOAD = "https://github.com/elumixor/pai/releases/latest/download/pai-macos.dmg";

const MODES: { value: Mode; label: string; icon: IconName }[] = [
  { value: "system", label: "System", icon: "monitor" },
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
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

/**
 * The few things that are this app's to decide: how it looks, where the daemon is. Everything
 * about the daemon itself is the daemon's own configuration, changed with `pai settings`.
 */
export function settingsView(pane: HTMLElement) {
  const modeRow = el("div.segmented");
  const lightGrid = el("div.swatches");
  const darkGrid = el("div.swatches");
  const paint = () => {
    const chosen = choice();
    clear(
      modeRow,
      ...MODES.map((option) =>
        el(
          "button.seg",
          {
            class: `seg${chosen.mode === option.value ? " on" : ""}`,
            onclick: () => {
              choose({ mode: option.value });
              paint();
            },
          },
          icon(option.icon, 14),
          el("span", {}, option.label),
        ),
      ),
    );
    clear(lightGrid, ...THEMES.filter((t) => t.kind === "light").map((t) => swatch(t, chosen.light === t.id, () => (choose({ light: t.id }), paint()))));
    clear(darkGrid, ...THEMES.filter((t) => t.kind === "dark").map((t) => swatch(t, chosen.dark === t.id, () => (choose({ dark: t.id }), paint()))));
  };
  paint();

  const row = (name: IconName, title: string, hint: string | undefined, control: HTMLElement) =>
    el("div.setting", {}, icon(name, 15), el("div.setting-text", {}, el("span.setting-title", {}, title), hint ? el("span.dim", {}, hint) : undefined), control);

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

  clear(
    pane,
    el("header.sheet-head", {}, icon("settings", 14), el("h2", {}, "Settings"), el("span.grow"), el("span.dim.kbd", {}, inDesktop ? "⌘," : "⌘⇧,")),
    el(
      "div.settings-list",
      {},
      row("sun", "Appearance", "follows the system unless you pick one", modeRow),
      el("div.setting.stack", {}, icon("sun", 15), el("div.setting-text", {}, el("span.setting-title", {}, "Light theme"), el("span.dim", {}, "used in light mode")), el("span"), lightGrid),
      el("div.setting.stack", {}, icon("moon", 15), el("div.setting-text", {}, el("span.setting-title", {}, "Dark theme"), el("span.dim", {}, "used in dark mode")), el("span"), darkGrid),
      inDesktop
        ? undefined
        : row("download", "Mac app", "the same client as a window · after installing run xattr -cr /Applications/pai.app once", el("a.btn", { href: DOWNLOAD }, icon("download", 13), el("span", {}, "Download"))),
      el("h3.section-title", {}, "Connection"),
      row("link", "Daemon", "the pai API this app talks to", address),
      row("key", "Token", "only if the daemon asks for one", secret),
    ),
  );
}
