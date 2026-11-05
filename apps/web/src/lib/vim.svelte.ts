const KEY = "pai.vim";

function stored() {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/** Vim keys in the editors and the message box: one choice per device. */
class Vim {
  #enabled = $state(stored());
  get enabled() {
    return this.#enabled;
  }
  set enabled(on: boolean) {
    this.#enabled = on;
    try {
      localStorage.setItem(KEY, on ? "1" : "0");
    } catch {
      // Private windows refuse storage: the choice lasts until the page closes.
    }
  }
}

export const vim = new Vim();
