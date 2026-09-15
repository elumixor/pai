import { baseUrl, inDesktop, setBaseUrl, setToken, token } from "./api.ts";
import { clear, el } from "./dom.ts";
import { icon, type IconName } from "./icons.ts";
import { setTheme, theme, type Theme } from "./theme.ts";

export const DOWNLOAD = "https://github.com/elumixor/pai/releases/latest/download/pai-macos.dmg";

const THEMES: { value: Theme; label: string; icon: IconName }[] = [
  { value: "system", label: "System", icon: "monitor" },
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
];

/**
 * The few things that are this app's to decide: how it looks, where the daemon is. Everything
 * about the daemon itself is the daemon's own configuration, changed with `pai settings`.
 */
export function settingsView(pane: HTMLElement) {
  const themeRow = el("div.segmented");
  const paint = () =>
    clear(
      themeRow,
      ...THEMES.map((option) =>
        el(
          "button.seg",
          {
            class: `seg${theme() === option.value ? " on" : ""}`,
            onclick: () => {
              setTheme(option.value);
              paint();
            },
          },
          icon(option.icon, 14),
          el("span", {}, option.label),
        ),
      ),
    );
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
      row("sun", "Appearance", "follows the system unless you pick one", themeRow),
      inDesktop
        ? undefined
        : row("download", "Mac app", "the same client as a window · after installing run xattr -cr /Applications/pai.app once", el("a.btn", { href: DOWNLOAD }, icon("download", 13), el("span", {}, "Download"))),
      el("h3.section-title", {}, "Connection"),
      row("link", "Daemon", "the pai API this app talks to", address),
      row("key", "Token", "only if the daemon asks for one", secret),
    ),
  );
}
