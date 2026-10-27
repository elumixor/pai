import { Clerk } from "@clerk/clerk-js";
import type { AuthConfig } from "./types";

const TOKEN_KEY = "pai.token";
const STARTUP_TIMEOUT_MS = 15_000;

class SignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignInError";
  }
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
 * Who the browser is to the daemon: a Clerk session (the account shared with Keep and Balance), or the daemon's
 * token when a link carried one (`/?token=…`) — what the CLI and the menu bar hand out.
 */
class Auth {
  loaded = $state(false);
  signedIn = $state(false);
  error = $state<string | null>(null);
  config = $state<AuthConfig>({ clerkPublishableKey: null, keepUrl: null });
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
      clerk.load(),
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

  async mountSignIn(element: HTMLDivElement) {
    await this.load();
    const clerk = this.#clerk;
    if (!clerk) return () => {};
    clerk.mountSignIn(element, { forceRedirectUrl: "/", signUpForceRedirectUrl: "/" });
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
