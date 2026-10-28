/** What `https://desk.atmagaming.com/bar.js` defines: the app switcher element and the list of desk apps. */
interface DeskApp {
  readonly id: string;
  readonly name: string;
  readonly what: string;
  readonly url: string;
  readonly current: boolean;
}

interface Window {
  desk?: { readonly apps: readonly DeskApp[] };
}

declare namespace svelteHTML {
  interface IntrinsicElements {
    "desk-bar": { class?: string; app?: string };
  }
}
