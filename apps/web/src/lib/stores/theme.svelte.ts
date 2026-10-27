const KEY = "pai.theme";

/** Light or dark, following the system until the person picks one. */
class Theme {
  dark = $state(typeof document !== "undefined" && document.documentElement.classList.contains("dark"));

  toggle() {
    this.dark = !this.dark;
    document.documentElement.classList.toggle("dark", this.dark);
    try {
      localStorage.setItem(KEY, this.dark ? "dark" : "light");
    } catch (error) {
      console.warn("[theme] could not remember the theme", error);
    }
  }
}

export const theme = new Theme();
