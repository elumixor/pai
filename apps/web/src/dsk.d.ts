/** What `https://dsk.atmagaming.com/bar.js` puts on the window: the dsk apps, for an app with a palette of its own. */
interface DskApp {
  readonly id: string;
  readonly name: string;
  readonly what: string;
  readonly url: string;
  readonly current: boolean;
}

interface Window {
  dsk?: { readonly apps: readonly DskApp[]; open(): void };
}

declare namespace svelteHTML {
  interface IntrinsicElements {
    "dsk-bar": { palette?: "own"; class?: string };
  }
}
