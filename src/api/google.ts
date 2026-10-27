import { config } from "../core/config.ts";
import { clerkConfigured } from "./clerk.ts";
import { logger } from "../core/log.ts";
import { clearSession, origin, sessionCookie, sessionFromRequest, sign, verify } from "./auth.ts";
import type { OAuthFinish } from "@desk/connector";

const log = logger("google");

/**
 * Sign in with Google for the browser surfaces: `/auth/google` sends the browser to Google,
 * `/auth/google/callback` turns the code into an email, and an email on the allowlist gets a
 * signed session cookie that every later request carries.
 *
 * The confidential-client flow: the id token comes straight from Google over TLS in exchange
 * for the code, so its claims are trusted without checking its signature, as Google's own
 * libraries do for this flow. The audience is still checked.
 */

const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const STATE_COOKIE = "pai_oauth";

/** Connectors' consents that come back through the one redirect URI, by the claim their state carries. */
const callbacks = new Map<string, OAuthFinish>();
export const onGoogleCallback = (claim: string, finish: OAuthFinish) => void callbacks.set(claim, finish);
/** The cookie the callback checks a state against; it rides on the redirect to Google. */
export const stateCookie = (state: string, req: Request) => `${STATE_COOKIE}=${state}; Path=/auth; Max-Age=600; HttpOnly; SameSite=Lax${secure(req)}`;

export const googleConfigured = () => Boolean(config.google.clientId && config.google.clientSecret);

/** Only a path on this host may be the place to return to; anything else is a redirect to elsewhere. */
const safeNext = (next: string | null) => (next && /^\/(?!\/)/.test(next) ? next : "/");

/** The web client's own sign-in, in its hash router. */
export const SIGN_IN = "/#/sign-in";

export const loginUrl = (next: string) => `/auth/google?next=${encodeURIComponent(next)}`;

export async function handleAuth(req: Request, url: URL): Promise<Response | undefined> {
  const path = url.pathname;
  if (path === "/auth/me") {
    const session = sessionFromRequest(req);
    return json(session ? { email: session.email, expires: session.exp } : { email: null });
  }
  if (path === "/auth/logout") {
    return redirect("/", { "set-cookie": clearSession() });
  }
  if (path === "/auth/config") {
    return json({ clerkPublishableKey: clerkConfigured() ? config.clerk.publishableKey : null, keepUrl: config.keepUrl || null });
  }
  // The consent screen links here; Google will not publish an app without a privacy policy.
  if (path === "/auth/privacy") return new Response(PRIVACY, { headers: { "content-type": "text/html; charset=utf-8" } });
  if (!googleConfigured()) {
    if (path.startsWith("/auth/")) return json({ error: "google sign-in is not configured (PAI_GOOGLE_CLIENT_ID, PAI_GOOGLE_CLIENT_SECRET)" }, 501);
    return undefined;
  }
  if (path === "/auth/google") {
    const next = safeNext(url.searchParams.get("next"));
    const state = sign({ next, nonce: crypto.randomUUID(), exp: Date.now() + 10 * 60 * 1000 });
    const params = new URLSearchParams({
      client_id: config.google.clientId,
      redirect_uri: callbackUrl(req, url),
      response_type: "code",
      scope: "openid email",
      state,
      prompt: "select_account",
    });
    return redirect(`${AUTH}?${params}`, { "set-cookie": stateCookie(state, req) });
  }
  if (path === "/auth/google/callback") {
    const state = url.searchParams.get("state") ?? "";
    const stored = /(?:^|;\s*)pai_oauth=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1];
    const claims = verify<{ next: string; exp: number } & Record<string, unknown>>(state);
    if (!claims || stored !== state || claims.exp < Date.now()) return json({ error: "the sign-in attempt expired; start again" }, 400);
    // The same redirect URI serves the modules' consents (a mailbox): one registered URI, several flows.
    for (const [claim, finish] of callbacks) if (claims[claim]) return finish(req, url, claims);
    const code = url.searchParams.get("code");
    if (!code) return json({ error: url.searchParams.get("error") ?? "google sent no code" }, 400);
    const email = await exchange(code, callbackUrl(req, url));
    if (!email) return json({ error: "google did not confirm an email address" }, 401);
    if (!config.allowed.includes(email.toLowerCase())) {
      log.warn(`${email} signed in but is not on PAI_ALLOWED`);
      return json({ error: `${email} is not allowed here` }, 403);
    }
    log.info(`${email} signed in`);
    return redirect(claims.next, { "set-cookie": sessionCookie(email, req) });
  }
  return undefined;
}

function callbackUrl(req: Request, url: URL) {
  return `${origin(req, url)}/auth/google/callback`;
}

async function exchange(code: string, redirectUri: string) {
  const response = await fetch(TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!response.ok) {
    log.warn(`token exchange failed: ${response.status} ${(await response.text()).slice(0, 200)}`);
    return undefined;
  }
  const { id_token } = (await response.json()) as { id_token?: string };
  const payload = id_token?.split(".")[1];
  if (!payload) return undefined;
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
    aud?: string;
    email?: string;
    email_verified?: boolean;
  };
  if (claims.aud !== config.google.clientId || !claims.email_verified) return undefined;
  return claims.email;
}

export const wantsHtml = (req: Request) => (req.headers.get("accept") ?? "").includes("text/html");

const secure = (req: Request) => (req.headers.get("x-forwarded-proto") === "https" ? "; Secure" : "");

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json" } });

const redirect = (to: string, headers: Record<string, string> = {}) =>
  new Response(null, { status: 302, headers: { location: to, ...headers } });

const PRIVACY = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>pai privacy</title>
<body style="font:16px/1.5 system-ui;max-width:40rem;margin:2rem auto;padding:0 1rem">
<h1>pai privacy policy</h1>
<p>pai is a personal assistant run by one person for their own use. Signing in with Google gives it your email address, which is checked against a list of allowed accounts.</p>
<p>Connecting a mailbox gives pai read-only access to that Gmail account. Mail is read on pai's own server to answer the owner's requests and is never sold, shared with third parties, or used for advertising. Google user data is handled in line with the Google API Services User Data Policy, including its Limited Use requirements.</p>
<p>Revoke access at any time at <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>; the stored token is then useless. Questions: vladogim97@gmail.com.</p>
</body>`;
