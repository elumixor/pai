import { baseUrl, flush, outbox, send, setBaseUrl, setToken, settings, token } from "./api.ts";
import { clear, el } from "./dom.ts";

/**
 * Settings are the daemon's, not the app's: they are read from and written to
 * `data/config.json` on the box, so every client sees the same configuration. The one
 * local setting is which daemon this app talks to.
 */
export async function settingsView(pane: HTMLElement) {
  const note = el("span.note");
  const rows = el("div.settings");
  clear(
    pane,
    el("header.pane-head", {}, el("h2", {}, "Settings"), el("span.grow"), note),
    el(
      "div.settings",
      {},
      el("label", {}, "daemon"),
      el("input", {
        value: baseUrl(),
        onchange: (event: Event) => {
          setBaseUrl((event.target as HTMLInputElement).value);
          location.reload();
        },
      }),
      el("label", {}, "token"),
      el("input", {
        value: token(),
        type: "password",
        placeholder: "only if the daemon asks for one",
        onchange: (event: Event) => {
          setToken((event.target as HTMLInputElement).value);
          location.reload();
        },
      }),
      el("label", {}, "outbox"),
      el(
        "div.row-inline",
        {},
        el("span", {}, `${outbox().length} queued`),
        el(
          "button.action",
          {
            onclick: async () => {
              note.textContent = `${await flush()} left in the outbox`;
            },
          },
          "Retry now",
        ),
      ),
    ),
    rows,
  );

  let data;
  try {
    data = await settings();
  } catch {
    rows.append(el("p.empty", {}, "The daemon's settings are not cached; connect to edit them."));
    return;
  }

  for (const key of data.editable) {
    const value = data.overrides[key] ?? data.effective[key] ?? "";
    const input = el("input", { value, placeholder: data.effective[key] ?? "" }) as HTMLInputElement;
    input.addEventListener("change", async () => {
      const { queued } = await send("/settings", { [key]: input.value }, "PATCH");
      note.textContent = queued ? "queued" : "saved — restart the daemon to apply";
    });
    rows.append(el("label", {}, key.replace(/^PAI_/, "").toLowerCase().replace(/_/g, " ")), input);
  }

  rows.append(
    el("label", {}, "daemon"),
    el(
      "div.row-inline",
      {},
      el("button.action", { onclick: () => void send("/restart", {}) }, "Restart"),
      el("button.action", { onclick: () => void send("/update", { force: false }) }, "Update"),
    ),
  );
}
