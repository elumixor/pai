import { baseUrl, flush, inDesktop, outbox, send, setBaseUrl, setToken, settings, sync, token } from "./api.ts";

export const DOWNLOAD = "https://github.com/elumixor/pai/releases/latest/download/pai-macos.dmg";
import { clear, el } from "./dom.ts";
import { icon } from "./icons.ts";

/**
 * Settings are the daemon's, not the app's: they are read from and written to
 * `data/config.json` on the box, so every client sees the same configuration. The one
 * local setting is which daemon this app talks to.
 */
export async function settingsView(pane: HTMLElement) {
  const note = el("span.note");
  const rows = el("div.settings");
  const field = (label: string, control: HTMLElement, hint?: string) =>
    el("div.field", {}, el("label", {}, label), el("div.control", {}, control, hint ? el("span.dim", {}, hint) : undefined));

  clear(
    pane,
    el("header.panel-head", {}, icon("settings", 14), el("h2", {}, "Settings"), el("span.grow"), note),
    el(
      "div.scroll",
      {},
      el("h3.section-title", {}, "This app"),
      el(
        "div.settings",
        {},
        field(
          "daemon",
          el("input", {
            value: baseUrl(),
            onchange: (event: Event) => {
              setBaseUrl((event.target as HTMLInputElement).value);
              location.reload();
            },
          }),
          "where the API is; changes reload the page",
        ),
        field(
          "token",
          el("input", {
            value: token(),
            type: "password",
            placeholder: "only if the daemon asks for one",
            onchange: (event: Event) => {
              setToken((event.target as HTMLInputElement).value);
              location.reload();
            },
          }),
        ),
        inDesktop
          ? undefined
          : field("desktop app", el("a", { href: DOWNLOAD }, "Download for macOS"), "the same client as a window; after installing run `xattr -cr /Applications/pai.app` once"),
        field(
          "outbox",
          el(
            "div.row-inline",
            {},
            el("span", {}, `${outbox().length} queued`),
            el("button.btn", { onclick: async () => (note.textContent = `${await flush()} left in the outbox`) }, "Retry now"),
          ),
        ),
      ),
      el("h3.section-title", {}, "Daemon"),
      rows,
    ),
  );

  try {
    const state = await sync();
    const peer = el("input", { value: state.peer, placeholder: "the other machine's device id" }) as HTMLInputElement;
    peer.addEventListener("change", async () => {
      const { queued } = await send("/settings", { PAI_SYNC: "1", PAI_SYNC_PEER: peer.value.trim() }, "PATCH");
      note.textContent = queued ? "queued" : "paired — restart the daemon to apply";
    });
    rows.append(
      field("sync", el("span", {}, `${state.enabled ? (state.running ? "running" : "starting") : "off"}  ${state.folders.map((f) => `${f.id} ${f.state ?? ""}`).join(" · ")}`)),
      field("this device", el("input", { value: state.deviceId, readonly: true })),
      field("paired with", peer),
    );
  } catch {
    /* an unreachable daemon has nothing to say about sync */
  }

  let data;
  try {
    data = await settings();
  } catch {
    rows.append(el("p.hint", {}, "The daemon's settings are not cached; connect to edit them."));
    return;
  }

  for (const key of data.editable) {
    const value = data.overrides[key] ?? data.effective[key] ?? "";
    const input = el("input", { value, placeholder: data.effective[key] ?? "" }) as HTMLInputElement;
    input.addEventListener("change", async () => {
      const { queued } = await send("/settings", { [key]: input.value }, "PATCH");
      note.textContent = queued ? "queued" : "saved — restart the daemon to apply";
    });
    rows.append(field(key.replace(/^PAI_/, "").toLowerCase().replace(/_/g, " "), input));
  }

  rows.append(
    field(
      "service",
      el(
        "div.row-inline",
        {},
        el("button.btn", { onclick: () => void send("/restart", {}) }, "Restart"),
        el("button.btn", { onclick: async () => (note.textContent = describe(await send("/update", { force: false }))) }, "Update"),
      ),
    ),
  );
}

const describe = (result: { queued: boolean; error?: string; data?: unknown }) => {
  if (result.queued) return "queued";
  if (result.error) return result.error;
  const data = result.data as { updated?: boolean; head?: string; reason?: string; restarting?: boolean } | undefined;
  if (!data?.updated) return data?.reason ?? "nothing to update";
  return `updated to ${data.head}${data.restarting ? " — restarting" : ""}`;
};
