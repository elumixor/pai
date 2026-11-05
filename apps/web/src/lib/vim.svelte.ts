import { api } from "./api";

const KEY = "pai.vim";

function stored() {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

function keep(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    // Private windows refuse storage: the choice lasts until the page closes.
  }
}

/** Vim keys in the editors and the message box: one choice, held by the daemon, this browser's copy for the first paint. */
class Vim {
  #enabled = $state(stored());
  get enabled() {
    return this.#enabled;
  }
  set enabled(on: boolean) {
    this.#enabled = on;
    keep(on);
    void api.savePrefs({ vim: on }).catch((error: Error) => console.warn("[vim] choice not saved", error));
  }

  async load() {
    const { vim } = await api.prefs().catch(() => ({ vim: undefined }) as { vim?: unknown });
    if (typeof vim === "boolean") {
      this.#enabled = vim;
      keep(vim);
    } else void api.savePrefs({ vim: this.#enabled }).catch((error: Error) => console.warn("[vim] choice not saved", error));
  }
}

export const vim = new Vim();
