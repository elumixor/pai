import { Clerk } from "@clerk/clerk-js";
import type { AuthConfig } from "./types";

const TOKEN_KEY = "pai.token";
const STARTUP_TIMEOUT_MS = 15_000;

type ClerkUiConstructor = NonNullable<NonNullable<NonNullable<Parameters<Clerk["load"]>[0]>["ui"]>["ClerkUI"]>;

class SignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignInError";
  }
}

/**
 * Clerk's prebuilt components ship as a separate bundle served by the instance's Frontend API. A development
 * instance injects it on its own; a production one only mounts components when it is handed the constructor.
 */
function loadClerkUi(publishableKey: string) {
  const frontendApi = atob(publishableKey.split("_")[2]).slice(0, -1);
  return new Promise<ClerkUiConstructor>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `https://${frontendApi}/npm/@clerk/ui@1/dist/ui.browser.js`;
    script.async = true;
    script.crossOrigin = "anonymous";
    script.onload = () =>
      resolve((window as unknown as { __internal_ClerkUICtor: ClerkUiConstructor }).__internal_ClerkUICtor);
    script.onerror = () => reject(new SignInError("Sign-in could not load its components."));
    document.head.appendChild(script);
  });
}

function storedToken(): string | null {
  try {
    const fromLink = new URLSearchParams(location.search).get("token");
    if (fromLink) localStorage.setItem(TOKEN_KEY, fromLink);
    return fromLink ?? localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/**
 * Who the browser is to the daemon: a Clerk session (the Desk account shared with Kip), or the daemon's
 * token when a link carried one (`/?token=…`) — what the CLI and the menu bar hand out.
 */
class Auth {
  loaded = $state(false);
  signedIn = $state(false);
  error = $state<string | null>(null);
  config = $state<AuthConfig>({ clerkPublishableKey: null, kipUrl: null });
  readonly #token = storedToken();
  #clerk: Clerk | null = null;
  #ready: Promise<void> | null = null;

  load() {
    this.#ready ??= this.#load().catch((error: Error) => {
      this.error = error.message;
      this.loaded = true;
    });
    return this.#ready;
  }

  async #load() {
    const response = await fetch("/auth/config");
    if (!response.ok) throw new SignInError(`The daemon did not answer (${response.status})`);
    this.config = (await response.json()) as AuthConfig;
    if (this.#token) {
      this.signedIn = true;
      this.loaded = true;
      return;
    }
    if (!this.config.clerkPublishableKey) throw new SignInError("Sign-in is not configured on this daemon; open it with a token link.");
    const clerk = new Clerk(this.config.clerkPublishableKey);
    (window as unknown as { Clerk: Clerk }).Clerk = clerk;
    await Promise.race([
      loadClerkUi(this.config.clerkPublishableKey).then((ClerkUI) => clerk.load({ ui: { ClerkUI } })),
      new Promise((_, reject) => setTimeout(() => reject(new SignInError("Sign-in took too long to load.")), STARTUP_TIMEOUT_MS)),
    ]);
    this.#clerk = clerk;
    this.signedIn = Boolean(clerk.session);
    clerk.addListener(({ session }) => {
      this.signedIn = Boolean(session);
    });
    this.loaded = true;
  }

  /** The header every request carries. */
  async header(): Promise<Record<string, string>> {
    await this.load();
    if (this.#token) return { authorization: `Bearer ${this.#token}` };
    const token = await this.#clerk?.session?.getToken();
    return token ? { authorization: `Bearer ${token}` } : {};
  }

  async mountSignIn(element: HTMLDivElement, redirect: string) {
    await this.load();
    const clerk = this.#clerk;
    if (!clerk) return () => {};
    clerk.mountSignIn(element, { forceRedirectUrl: redirect, signUpForceRedirectUrl: redirect });
    return () => clerk.unmountSignIn(element);
  }

  async signOut() {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch (error) {
      console.warn("[auth] could not forget the token", error);
    }
    await this.#clerk?.signOut({ redirectUrl: "/" });
  }
}

export const auth = new Auth();
